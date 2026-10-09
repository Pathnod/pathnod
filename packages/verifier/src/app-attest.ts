import { createHash, timingSafeEqual, verify, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { decodeCbor, decodeCborPrefix, requireCborMap } from "./app-attest-cbor.ts";
import type { CborValue } from "./app-attest-cbor.ts";
import { extractAppAttestNonce } from "./app-attest-der.ts";

export type AppAttestEnvironment = "development" | "production";

export type AppAttestVerificationErrorCode =
  | "invalid_input"
  | "challenge_limit"
  | "invalid_attestation"
  | "invalid_chain"
  | "invalid_nonce"
  | "invalid_key"
  | "invalid_app"
  | "invalid_environment"
  | "invalid_counter"
  | "invalid_assertion";

export class AppAttestVerificationError extends Error {
  readonly code: AppAttestVerificationErrorCode;
  readonly detail?: string;

  constructor(code: AppAttestVerificationErrorCode, detail?: string) {
    super(`App Attest verification failed: ${code}.`);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface AppAttestPolicy {
  readonly appID: string;
  readonly environment: AppAttestEnvironment;
  readonly allowedValidationCategories: readonly number[];
  readonly allowedBundleVersions: readonly string[];
}

export interface VerifiedAppAttestKey {
  readonly keyID: string;
  readonly publicKeyPem: string;
  readonly appID: string;
  readonly environment: AppAttestEnvironment;
  readonly counter: number;
  readonly validationCategory?: number;
  readonly bundleVersion?: string;
}

export interface VerifyAppAttestAttestationInput {
  readonly keyID: string;
  readonly object: Uint8Array;
  readonly expectedChallenge: Uint8Array;
}

export interface VerifyAppAttestAssertionInput {
  readonly key: VerifiedAppAttestKey;
  readonly object: Uint8Array;
  readonly expectedChallenge: Uint8Array;
  /** Observation assertions already receive the canonical transcript hash on iOS. */
  readonly challengeIsClientDataHash?: boolean;
}

const APP_ATTEST_ROOT = new X509Certificate(
  readFileSync(new URL("../Apple_App_Attestation_Root_CA.crt", import.meta.url)),
);
const DEVELOPMENT_AAGUID = Buffer.from("appattestdevelop", "ascii");
const PRODUCTION_AAGUID = Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7)]);

function digest(...parts: Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function fail(code: AppAttestVerificationErrorCode): never {
  throw new AppAttestVerificationError(code);
}

function bytes(value: CborValue | undefined, code: AppAttestVerificationErrorCode): Buffer {
  if (!Buffer.isBuffer(value)) fail(code);
  return value;
}

function checkChallenge(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) fail("invalid_input");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function decodeKeyID(keyID: string): Buffer {
  if (typeof keyID !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(keyID)) fail("invalid_input");
  const decoded = Buffer.from(keyID, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== keyID) fail("invalid_input");
  return decoded;
}

function asMap(value: CborValue, keys: readonly (string | number)[], code: AppAttestVerificationErrorCode): Map<string | number, CborValue> {
  try {
    return requireCborMap(value, keys);
  } catch {
    return fail(code);
  }
}

function certificateValidNow(certificate: X509Certificate, now: number): boolean {
  return Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo);
}

function verifyCertificateChain(leafDer: Buffer, intermediateDer: Buffer): X509Certificate {
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    leaf = new X509Certificate(leafDer);
    intermediate = new X509Certificate(intermediateDer);
  } catch {
    return fail("invalid_chain");
  }
  const now = Date.now();
  if (
    leaf.ca || !intermediate.ca || !APP_ATTEST_ROOT.ca ||
    !leaf.keyUsage?.includes("1.2.840.113635.100.4.24") ||
    !certificateValidNow(leaf, now) || !certificateValidNow(intermediate, now) ||
    !certificateValidNow(APP_ATTEST_ROOT, now) ||
    !leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey) ||
    !intermediate.checkIssued(APP_ATTEST_ROOT) || !intermediate.verify(APP_ATTEST_ROOT.publicKey) ||
    !APP_ATTEST_ROOT.verify(APP_ATTEST_ROOT.publicKey)
  ) {
    fail("invalid_chain");
  }
  return leaf;
}

interface AuthenticatorData {
  readonly rpID: Buffer;
  readonly counter: number;
  readonly flags: number;
  readonly extensions: Map<string | number, CborValue> | undefined;
}

function parseExtensions(data: Buffer, flags: number, offset: number): Map<string | number, CborValue> | undefined {
  if ((flags & 0x80) === 0) {
    if (offset !== data.length) fail("invalid_attestation");
    return undefined;
  }
  if (offset >= data.length) fail("invalid_attestation");
  const value = decodeCbor(data.subarray(offset));
  if (!(value instanceof Map)) fail("invalid_attestation");
  return value;
}

function parseAuthenticatorData(data: Buffer, attestation: boolean): AuthenticatorData & { credentialID?: Buffer; coseKey?: CborValue } {
  if (data.length < 37) fail("invalid_attestation");
  const rpID = data.subarray(0, 32);
  const flags = data[32]!;
  const counter = data.readUInt32BE(33);
  if (!attestation) {
    return { rpID, flags, counter, extensions: parseExtensions(data, flags, 37) };
  }
  if ((flags & 0x40) === 0 || data.length < 55) fail("invalid_attestation");
  const credentialLength = data.readUInt16BE(53);
  if (credentialLength !== 32 || data.length < 55 + credentialLength) fail("invalid_attestation");
  const credentialID = data.subarray(55, 55 + credentialLength);
  const cose = decodeCborPrefix(data.subarray(55 + credentialLength));
  const extensions = parseExtensions(data, flags, 55 + credentialLength + cose.bytesRead);
  return { rpID, flags, counter, credentialID, coseKey: cose.value, extensions };
}

function extensionValues(extensions: Map<string | number, CborValue> | undefined): { validationCategory?: number; bundleVersion?: string } {
  if (extensions === undefined) return {};
  const category = extensions.get("apple_validation_category_01");
  if (category !== undefined && (!Buffer.isBuffer(category) || category.length !== 4)) {
    throw new AppAttestVerificationError("invalid_environment", "validation_category_format");
  }
  const bundleVersion = extensions.get("apple_bundle_version_01");
  if (bundleVersion !== undefined && (typeof bundleVersion !== "string" || bundleVersion.length === 0)) {
    throw new AppAttestVerificationError("invalid_environment", "bundle_version_format");
  }
  return {
    ...(category === undefined ? {} : { validationCategory: category.readUInt32LE(0) }),
    ...(bundleVersion === undefined ? {} : { bundleVersion }),
  };
}

function checkCoseKey(value: CborValue | undefined, publicKey: X509Certificate["publicKey"]): void {
  if (value === undefined) fail("invalid_key");
  const map = asMap(value, [1, 3, -1, -2, -3], "invalid_key");
  if (map.get(1) !== 2 || map.get(3) !== -7 || map.get(-1) !== 1) fail("invalid_key");
  const x = bytes(map.get(-2), "invalid_key");
  const y = bytes(map.get(-3), "invalid_key");
  if (x.length !== 32 || y.length !== 32) fail("invalid_key");
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) fail("invalid_key");
  if (!equal(x, Buffer.from(jwk.x, "base64url")) || !equal(y, Buffer.from(jwk.y, "base64url"))) {
    fail("invalid_key");
  }
}

export class AppAttestVerifier {
  readonly #policy: AppAttestPolicy;
  readonly #rpID: Buffer;

  constructor(policy: AppAttestPolicy) {
    if (
      typeof policy.appID !== "string" || !/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(policy.appID) ||
      (policy.environment !== "development" && policy.environment !== "production") ||
      (process.env.NODE_ENV === "production" && policy.environment === "development") ||
      !Array.isArray(policy.allowedValidationCategories) || policy.allowedValidationCategories.length === 0 ||
      policy.allowedValidationCategories.some((value) => ![2, 3, 4, 5].includes(value)) ||
      !Array.isArray(policy.allowedBundleVersions) ||
      policy.allowedBundleVersions.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      fail("invalid_input");
    }
    this.#policy = policy;
    this.#rpID = digest(Buffer.from(policy.appID, "utf8"));
  }

  verifyAttestation(input: VerifyAppAttestAttestationInput): VerifiedAppAttestKey {
    const keyID = decodeKeyID(input.keyID);
    const challenge = checkChallenge(input.expectedChallenge);
    let object: CborValue;
    try {
      object = decodeCbor(input.object);
    } catch {
      return fail("invalid_attestation");
    }
    const outer = asMap(object, ["fmt", "attStmt", "authData"], "invalid_attestation");
    if (outer.get("fmt") !== "apple-appattest") fail("invalid_attestation");
    const statement = asMap(outer.get("attStmt")!, ["x5c", "receipt"], "invalid_attestation");
    const chain = statement.get("x5c");
    if (!Array.isArray(chain) || chain.length !== 2) fail("invalid_chain");
    const leafDer = bytes(chain[0], "invalid_chain");
    const intermediateDer = bytes(chain[1], "invalid_chain");
    if (bytes(statement.get("receipt"), "invalid_attestation").length === 0) fail("invalid_attestation");
    const authData = bytes(outer.get("authData"), "invalid_attestation");
    const certificate = verifyCertificateChain(leafDer, intermediateDer);
    const expectedNonce = digest(authData, digest(challenge));
    let actualNonce: Buffer;
    try {
      actualNonce = extractAppAttestNonce(leafDer);
    } catch {
      return fail("invalid_nonce");
    }
    if (!equal(actualNonce, expectedNonce)) fail("invalid_nonce");
    const publicKey = certificate.publicKey;
    if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      fail("invalid_key");
    }
    const jwk = publicKey.export({ format: "jwk" });
    if (!jwk.x || !jwk.y) fail("invalid_key");
    const uncompressed = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    if (!equal(digest(uncompressed), keyID)) fail("invalid_key");

    let parsed: ReturnType<typeof parseAuthenticatorData>;
    try {
      parsed = parseAuthenticatorData(authData, true);
    } catch {
      return fail("invalid_attestation");
    }
    if (!equal(parsed.rpID, this.#rpID)) fail("invalid_app");
    if (parsed.counter !== 0) fail("invalid_counter");
    const expectedAAGUID = this.#policy.environment === "development" ? DEVELOPMENT_AAGUID : PRODUCTION_AAGUID;
    if (!equal(authData.subarray(37, 53), expectedAAGUID)) {
      throw new AppAttestVerificationError("invalid_environment", "aaguid");
    }
    if (parsed.credentialID === undefined || !equal(parsed.credentialID, keyID)) fail("invalid_key");
    checkCoseKey(parsed.coseKey, publicKey);
    const extensions = extensionValues(parsed.extensions);
    if (extensions.validationCategory !== undefined && !this.#policy.allowedValidationCategories.includes(extensions.validationCategory)) {
      throw new AppAttestVerificationError("invalid_environment", "validation_category");
    }
    this.#checkBundleVersion(extensions.bundleVersion, parsed.extensions === undefined);
    return {
      keyID: input.keyID,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      appID: this.#policy.appID,
      environment: this.#policy.environment,
      counter: 0,
      ...extensions,
    };
  }

  verifyAssertion(input: VerifyAppAttestAssertionInput): VerifiedAppAttestKey {
    const challenge = checkChallenge(input.expectedChallenge);
    if (input.key.appID !== this.#policy.appID || input.key.environment !== this.#policy.environment) {
      fail("invalid_app");
    }
    decodeKeyID(input.key.keyID);
    let object: CborValue;
    try {
      object = decodeCbor(input.object);
    } catch {
      return fail("invalid_assertion");
    }
    const outer = asMap(object, ["signature", "authenticatorData"], "invalid_assertion");
    const signature = bytes(outer.get("signature"), "invalid_assertion");
    const authData = bytes(outer.get("authenticatorData"), "invalid_assertion");
    let parsed: ReturnType<typeof parseAuthenticatorData>;
    try {
      parsed = parseAuthenticatorData(authData, false);
    } catch {
      return fail("invalid_assertion");
    }
    if (!equal(parsed.rpID, this.#rpID)) fail("invalid_app");
    if (!Number.isInteger(input.key.counter) || parsed.counter <= input.key.counter) fail("invalid_counter");
    const extensions = extensionValues(parsed.extensions);
    if (extensions.validationCategory !== undefined && !this.#policy.allowedValidationCategories.includes(extensions.validationCategory)) {
      throw new AppAttestVerificationError("invalid_environment", "validation_category");
    }
    if (input.key.validationCategory !== undefined && extensions.validationCategory !== input.key.validationCategory) {
      throw new AppAttestVerificationError("invalid_environment", "validation_category_changed");
    }
    if (input.key.bundleVersion !== undefined && extensions.bundleVersion === undefined) {
      throw new AppAttestVerificationError("invalid_environment", "bundle_version");
    }
    this.#checkBundleVersion(extensions.bundleVersion,
      parsed.extensions === undefined && input.key.validationCategory === undefined && input.key.bundleVersion === undefined);
    let signatureValid = false;
    try {
      signatureValid = verify(
        "sha256",
        digest(authData, input.challengeIsClientDataHash ? challenge : digest(challenge)),
        input.key.publicKeyPem,
        signature,
      );
    } catch {
      fail("invalid_key");
    }
    if (!signatureValid) fail("invalid_assertion");
    return { ...input.key, counter: parsed.counter, ...extensions };
  }

  #checkBundleVersion(version: string | undefined, legacy: boolean): void {
    // Pre-iOS 27 authenticator data has no extensions; Apple still authenticates it.
    if (version === undefined && legacy) return;
    if (version === undefined ? this.#policy.allowedBundleVersions.length > 0 : !this.#policy.allowedBundleVersions.includes(version)) {
      throw new AppAttestVerificationError("invalid_environment", "bundle_version");
    }
  }
}
