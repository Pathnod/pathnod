import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { decodeCbor } from "../src/app-attest-cbor.ts";
import { extractAppAttestNonce } from "../src/app-attest-der.ts";
import { AppAttestGate } from "../src/app-attest-gate.ts";
import { AppAttestVerifier, AppAttestVerificationError } from "../src/app-attest.ts";
import type { VerifiedAppAttestKey } from "../src/app-attest.ts";

const appID = "U5MCCC24G5.xyz.pathnod.appattestspike";
const developmentPolicy = { appID, environment: "development", allowedValidationCategories: [3], allowedBundleVersions: [] } as const;

function rejectsCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AppAttestVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const result = Buffer.alloc(3);
  result[0] = (major << 5) | 25;
  result.writeUInt16BE(length, 1);
  return result;
}

function cbor(value: Buffer | string | Map<string, Buffer | string>): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  const entries: Buffer[] = [];
  for (const [key, item] of value) entries.push(cbor(key), cbor(item));
  return Buffer.concat([cborHead(5, value.size), ...entries]);
}

function signedAssertion(
  privateKey: KeyObject,
  challenge: Buffer,
  counter: number,
  bundleVersion: string | undefined,
  category = 3,
): Buffer {
  const categoryBytes = Buffer.alloc(4);
  categoryBytes.writeUInt32LE(category);
  const extensions = new Map<string, Buffer | string>([["apple_validation_category_01", categoryBytes]]);
  if (bundleVersion !== undefined) extensions.set("apple_bundle_version_01", bundleVersion);
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authData = Buffer.concat([sha256(Buffer.from(appID)), Buffer.from([0x80]), counterBytes, cbor(extensions)]);
  const signature = sign("sha256", sha256(authData, sha256(challenge)), privateKey);
  return cbor(new Map([["signature", signature], ["authenticatorData", authData]]));
}

function syntheticEnrollment(): { key: VerifiedAppAttestKey; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    key: {
      keyID: randomBytes(32).toString("base64"),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      appID,
      environment: "development",
      counter: 0,
      validationCategory: 3,
      bundleVersion: "1",
    },
    privateKey,
  };
}

function legacyAssertion(privateKey: KeyObject, challenge: Buffer, counter: number): Buffer {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authData = Buffer.concat([sha256(Buffer.from(appID)), Buffer.from([0]), counterBytes]);
  const signature = sign("sha256", sha256(authData, sha256(challenge)), privateKey);
  return cbor(new Map([["signature", signature], ["authenticatorData", authData]]));
}

describe("strict App Attest inputs", () => {
  it("pins the Apple App Attestation root certificate", () => {
    const root = new X509Certificate(readFileSync(new URL("../Apple_App_Attestation_Root_CA.crt", import.meta.url)));
    assert.equal(root.fingerprint256, "1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32");
  });

  it("rejects duplicate CBOR keys, trailing bytes, and indefinite lengths", () => {
    assert.equal((decodeCbor(Buffer.from([0xa1, 0x61, 0x78, 0x01])) as Map<string, number>).get("x"), 1);
    assert.throws(() => decodeCbor(Buffer.from([0xa2, 0x61, 0x78, 0x01, 0x61, 0x78, 0x02])));
    assert.throws(() => decodeCbor(Buffer.from([0xa1, 0x61, 0x78, 0x01, 0x00])));
    assert.throws(() => decodeCbor(Buffer.from([0x9f, 0xff])));
  });

  it("rejects missing or ambiguous app policy", () => {
    rejectsCode("invalid_input", () => new AppAttestVerifier({ ...developmentPolicy, appID: "xyz.pathnod.appattestspike" }));
    rejectsCode("invalid_input", () => new AppAttestVerifier({ ...developmentPolicy, allowedValidationCategories: [] }));
    rejectsCode("invalid_input", () => new AppAttestVerifier({ ...developmentPolicy, allowedBundleVersions: [""] }));
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      rejectsCode("invalid_input", () => new AppAttestVerifier(developmentPolicy));
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("persists one-time challenges and consumes a failed attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "pathnod-app-attest-test-"));
    const path = join(directory, "gate.sqlite");
    try {
      let gate = new AppAttestGate(path, developmentPolicy);
      const trial = gate.issueTrial();
      assert.equal(trial.attestation.bytes.length, 32);
      assert.notDeepEqual(trial.firstAssertion.bytes, trial.secondAssertion.bytes);
      gate.close();

      gate = new AppAttestGate(path, developmentPolicy);
      rejectsCode("invalid_attestation", () => gate.acceptAttestation(trial.attestation.id, randomBytes(32).toString("base64"), Buffer.from([0xa0])));
      rejectsCode("invalid_input", () => gate.acceptAttestation(trial.attestation.id, randomBytes(32).toString("base64"), Buffer.from([0xa0])));
      gate.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it("checks Apple's public certificate and nonce sample without device evidence", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/apple-validation-sample.json", import.meta.url), "utf8")) as {
    challenge: string;
    leafDerBase64: string;
    intermediateDerBase64: string;
    authDataAndChallengeBase64: string;
    nonceBase64: string;
  };
  const leafDer = Buffer.from(fixture.leafDerBase64, "base64");
  const intermediate = new X509Certificate(Buffer.from(fixture.intermediateDerBase64, "base64"));
  const leaf = new X509Certificate(leafDer);
  assert.ok(leaf.checkIssued(intermediate));
  assert.ok(leaf.verify(intermediate.publicKey));

  const challenge = Buffer.from(fixture.challenge);
  const combined = Buffer.from(fixture.authDataAndChallengeBase64, "base64");
  assert.deepEqual(combined.subarray(-challenge.length), challenge);
  const authData = combined.subarray(0, -challenge.length);
  const nonce = extractAppAttestNonce(leafDer);
  assert.deepEqual(nonce, Buffer.from(fixture.nonceBase64, "base64"));
  assert.deepEqual(nonce, sha256(authData, challenge));
  assert.notDeepEqual(nonce, sha256(authData, Buffer.from("altered_challenge")));

  const alteredCertificate = Buffer.from(leafDer);
  alteredCertificate[alteredCertificate.length - 1]! ^= 1;
  assert.equal(new X509Certificate(alteredCertificate).verify(intermediate.publicKey), false);
  const attestationObject = Buffer.concat([
    cborHead(5, 3), cbor("fmt"), cbor("apple-appattest"), cbor("attStmt"),
    cborHead(5, 2), cbor("x5c"), cborHead(4, 2), cbor(leafDer), cbor(Buffer.from(fixture.intermediateDerBase64, "base64")),
    cbor("receipt"), cbor(Buffer.from([1])), cbor("authData"), cbor(authData),
  ]);
  rejectsCode("invalid_chain", () => new AppAttestVerifier(developmentPolicy).verifyAttestation({
    keyID: randomBytes(32).toString("base64"), object: attestationObject, expectedChallenge: randomBytes(32),
  }));
  const alteredNonceExtension = Buffer.from(leafDer);
  const oid = Buffer.from("2a864886f763640802", "hex");
  const oidOffset = alteredNonceExtension.indexOf(oid);
  assert.ok(oidOffset >= 0);
  alteredNonceExtension[oidOffset + oid.length - 1]! ^= 1;
  assert.throws(() => extractAppAttestNonce(alteredNonceExtension));
});

it("accepts a signed assertion after an authorized app update and rejects altered proofs", () => {
  const policy = { ...developmentPolicy, allowedBundleVersions: ["1", "2"] };
  const verifier = new AppAttestVerifier(policy);
  const { key, privateKey } = syntheticEnrollment();
  const challenge = randomBytes(32);
  const updated = signedAssertion(privateKey, challenge, 1, "2");
  const verified = verifier.verifyAssertion({ key, object: updated, expectedChallenge: challenge });
  assert.equal(verified.counter, 1);
  assert.equal(verified.bundleVersion, "2");

  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({ key, object: updated, expectedChallenge: randomBytes(32) }));
  const changedSignature = Buffer.from(updated);
  const signature = (decodeCbor(updated) as Map<string, Buffer>).get("signature")!;
  const signatureOffset = changedSignature.indexOf(signature);
  assert.ok(signatureOffset >= 0);
  changedSignature[signatureOffset + signature.length - 1]! ^= 1;
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({ key, object: changedSignature, expectedChallenge: challenge }));
  rejectsCode("invalid_counter", () => verifier.verifyAssertion({ key: verified, object: updated, expectedChallenge: challenge }));
  rejectsCode("invalid_counter", () => verifier.verifyAssertion({ key: verified, object: signedAssertion(privateKey, challenge, 0, "2"), expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => verifier.verifyAssertion({ key, object: signedAssertion(privateKey, challenge, 1, "3"), expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => verifier.verifyAssertion({ key, object: signedAssertion(privateKey, challenge, 1, undefined), expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => verifier.verifyAssertion({ key, object: signedAssertion(privateKey, challenge, 1, "2", 4), expectedChallenge: challenge }));
  rejectsCode("invalid_app", () => verifier.verifyAssertion({ key: { ...key, appID: "U5MCCC24G5.xyz.pathnod.wrong" }, object: updated, expectedChallenge: challenge }));
});

it("persists the authorized app version alongside the assertion counter", () => {
  const directory = mkdtempSync(join(tmpdir(), "pathnod-app-attest-update-"));
  const path = join(directory, "gate.sqlite");
  try {
    const policy = { ...developmentPolicy, allowedBundleVersions: ["1", "2"] };
    const gate = new AppAttestGate(path, policy);
    const { key, privateKey } = syntheticEnrollment();
    const database = new DatabaseSync(path);
    database.prepare(`
      INSERT INTO app_attest_keys
      (key_id, public_key_pem, app_id, environment, counter, validation_category, bundle_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(key.keyID, key.publicKeyPem, key.appID, key.environment, key.counter, key.validationCategory!, key.bundleVersion!);
    database.close();

    const challenge = gate.issueChallenge("assertion", key.keyID);
    const verified = gate.acceptAssertion(challenge.id, key.keyID, signedAssertion(privateKey, challenge.bytes, 1, "2"));
    assert.equal(verified.bundleVersion, "2");
    assert.equal(gate.getKey(key.keyID)?.bundleVersion, "2");
    assert.equal(gate.getKey(key.keyID)?.counter, 1);
    gate.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("accepts signed pre-iOS 27 assertions with pinned versions and still rejects tampering and replay", () => {
  const verifier = new AppAttestVerifier({ ...developmentPolicy, allowedBundleVersions: ["1"] });
  const enrolled = syntheticEnrollment();
  const { validationCategory: _category, bundleVersion: _version, ...legacyKey } = enrolled.key;
  const challenge = randomBytes(32);
  const assertion = legacyAssertion(enrolled.privateKey, challenge, 1);
  const verified = verifier.verifyAssertion({ key: legacyKey, object: assertion, expectedChallenge: challenge });
  assert.equal(verified.counter, 1);
  assert.equal(verified.bundleVersion, undefined);
  assert.equal(verified.validationCategory, undefined);
  const modern = decodeCbor(signedAssertion(enrolled.privateKey, challenge, 1, "1")) as Map<string, Buffer>;
  const stripped = Buffer.from(modern.get("authenticatorData")!.subarray(0, 37));
  stripped[32] = 0;
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({
    key: legacyKey, object: cbor(new Map([["signature", modern.get("signature")!], ["authenticatorData", stripped]])),
    expectedChallenge: challenge,
  }));
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({
    key: legacyKey, object: assertion, expectedChallenge: randomBytes(32),
  }));
  rejectsCode("invalid_counter", () => verifier.verifyAssertion({ key: verified, object: assertion, expectedChallenge: challenge }));
  const { privateKey: otherKey } = syntheticEnrollment();
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({
    key: legacyKey, object: legacyAssertion(otherKey, challenge, 1), expectedChallenge: challenge,
  }));
  rejectsCode("invalid_environment", () => verifier.verifyAssertion({
    key: legacyKey, object: signedAssertion(enrolled.privateKey, challenge, 1, undefined), expectedChallenge: challenge,
  }));
});

it("pins extensions after a legacy key upgrades and refuses a later downgrade", () => {
  const verifier = new AppAttestVerifier({ ...developmentPolicy, allowedBundleVersions: ["1"] });
  const enrolled = syntheticEnrollment();
  const { validationCategory: _category, bundleVersion: _version, ...legacyKey } = enrolled.key;
  const challenge = randomBytes(32);
  const upgraded = verifier.verifyAssertion({ key: legacyKey,
    object: signedAssertion(enrolled.privateKey, challenge, 1, "1"), expectedChallenge: challenge });
  assert.equal(upgraded.bundleVersion, "1");
  assert.equal(upgraded.validationCategory, 3);
  rejectsCode("invalid_environment", () => verifier.verifyAssertion({ key: upgraded,
    object: legacyAssertion(enrolled.privateKey, challenge, 2), expectedChallenge: challenge }));
  const { validationCategory: _upgradedCategory, ...versionOnly } = upgraded;
  rejectsCode("invalid_environment", () => verifier.verifyAssertion({ key: versionOnly,
    object: legacyAssertion(enrolled.privateKey, challenge, 2), expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => verifier.verifyAssertion({ key: legacyKey,
    object: signedAssertion(enrolled.privateKey, challenge, 1, "2"), expectedChallenge: challenge }));
});

it("persists a legacy key's new signed metadata across a server restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "pathnod-app-attest-legacy-"));
  const path = join(directory, "gate.sqlite");
  const policy = { ...developmentPolicy, allowedBundleVersions: ["1"], allowedValidationCategories: [3, 4] };
  let gate: AppAttestGate | undefined;
  try {
    gate = new AppAttestGate(path, policy);
    const { key, privateKey } = syntheticEnrollment();
    const db = new DatabaseSync(path);
    db.prepare(`INSERT INTO app_attest_keys
      (key_id, public_key_pem, app_id, environment, counter, validation_category, bundle_version)
      VALUES (?, ?, ?, ?, 0, NULL, NULL)`).run(key.keyID, key.publicKeyPem, key.appID, key.environment);
    db.close();
    const legacy = gate.issueChallenge("assertion", key.keyID);
    gate.acceptAssertion(legacy.id, key.keyID, legacyAssertion(privateKey, legacy.bytes, 1));
    const upgrade = gate.issueChallenge("assertion", key.keyID);
    gate.acceptAssertion(upgrade.id, key.keyID, signedAssertion(privateKey, upgrade.bytes, 2, "1"));
    gate.close();
    gate = new AppAttestGate(path, policy);
    assert.equal(gate.getKey(key.keyID)?.validationCategory, 3);
    assert.equal(gate.getKey(key.keyID)?.bundleVersion, "1");
    assert.equal(gate.getKey(key.keyID)?.counter, 2);
    const downgrade = gate.issueChallenge("assertion", key.keyID);
    rejectsCode("invalid_environment", () => gate!.acceptAssertion(downgrade.id, key.keyID,
      legacyAssertion(privateKey, downgrade.bytes, 3)));
    const categoryChange = gate.issueChallenge("assertion", key.keyID);
    rejectsCode("invalid_environment", () => gate!.acceptAssertion(categoryChange.id, key.keyID,
      signedAssertion(privateKey, categoryChange.bytes, 3, "1", 4)));
    assert.equal(gate.getKey(key.keyID)?.counter, 2);
  } finally {
    gate?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

interface LocalEvidence {
  keyID: string;
  attestationChallenge: string;
  firstAssertionChallenge: string;
  secondAssertionChallenge: string;
  attestation: string;
  firstAssertion: string;
  secondAssertion: string;
}

const localEvidencePath = process.env.PATHNOD_DEV19_EVIDENCE;
const hasLocalEvidence = localEvidencePath !== undefined && existsSync(localEvidencePath);

it("validates real iPhone evidence and rejects altered trust inputs", { skip: !hasLocalEvidence }, () => {
  const evidence = JSON.parse(readFileSync(localEvidencePath!, "utf8")) as LocalEvidence;
  const bytes = (value: string): Buffer => Buffer.from(value, "base64");
  const attestation = bytes(evidence.attestation);
  const challenge = bytes(evidence.attestationChallenge);
  const firstAssertion = bytes(evidence.firstAssertion);
  const firstChallenge = bytes(evidence.firstAssertionChallenge);
  const secondAssertion = bytes(evidence.secondAssertion);
  const secondChallenge = bytes(evidence.secondAssertionChallenge);
  const verifier = new AppAttestVerifier(developmentPolicy);

  const enrolled = verifier.verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge });
  assert.equal(enrolled.counter, 0);
  assert.equal(enrolled.validationCategory, 3);
  const afterFirst = verifier.verifyAssertion({ key: enrolled, object: firstAssertion, expectedChallenge: firstChallenge });
  assert.equal(afterFirst.counter, 1);
  const afterSecond = verifier.verifyAssertion({ key: afterFirst, object: secondAssertion, expectedChallenge: secondChallenge });
  assert.equal(afterSecond.counter, 2);

  rejectsCode("invalid_nonce", () => verifier.verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: randomBytes(32) }));
  rejectsCode("invalid_key", () => verifier.verifyAttestation({ keyID: Buffer.alloc(32).toString("base64"), object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_app", () => new AppAttestVerifier({ ...developmentPolicy, appID: "U5MCCC24G5.xyz.pathnod.wrong" }).verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => new AppAttestVerifier({ ...developmentPolicy, environment: "production" }).verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => new AppAttestVerifier({ ...developmentPolicy, allowedValidationCategories: [4] }).verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({ key: enrolled, object: firstAssertion, expectedChallenge: randomBytes(32) }));
  rejectsCode("invalid_counter", () => verifier.verifyAssertion({ key: afterFirst, object: firstAssertion, expectedChallenge: firstChallenge }));

  const decoded = decodeCbor(attestation) as Map<string, Map<string, Buffer[]>>;
  const leaf = decoded.get("attStmt")!.get("x5c")![0]!;
  const changedCertificate = Buffer.from(attestation);
  const leafOffset = changedCertificate.indexOf(leaf);
  assert.ok(leafOffset >= 0);
  changedCertificate[leafOffset + leaf.length - 1]! ^= 1;
  rejectsCode("invalid_chain", () => verifier.verifyAttestation({ keyID: evidence.keyID, object: changedCertificate, expectedChallenge: challenge }));

  const assertionMap = decodeCbor(firstAssertion) as Map<string, Buffer>;
  const signature = assertionMap.get("signature")!;
  const changedSignature = Buffer.from(firstAssertion);
  const signatureOffset = changedSignature.indexOf(signature);
  assert.ok(signatureOffset >= 0);
  changedSignature[signatureOffset + signature.length - 1]! ^= 1;
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({ key: enrolled, object: changedSignature, expectedChallenge: firstChallenge }));
});
