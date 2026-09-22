import { createHash, timingSafeEqual } from "node:crypto";

import { decodeBase64UrlStrict } from "./base64url.ts";
import { evaluateDevelopmentStubEnablement } from "./configuration.ts";
import {
  ATTESTATION_SCHEMA_VERSION,
  CLIENT_DATA_HASH_BYTE_LENGTH,
  DEVELOPMENT_ENVIRONMENT,
  DEVELOPMENT_STUB_ASSURANCE,
  DEVELOPMENT_STUB_DOMAIN_SEPARATOR,
  DEVELOPMENT_STUB_PROVIDER,
  PROOF_BYTE_LENGTH,
  isAttestationPurpose,
} from "./contract.ts";
import type { AttestationEnvelope, AttestationPurpose, AttestationVerificationResult, EnvironmentSource } from "./contract.ts";
import { AttestationVerificationError } from "./errors.ts";
import { consoleAttestationWarningLogger, developmentStubAcceptedWarning } from "./logging.ts";
import type { AttestationWarningLogger } from "./logging.ts";
import type { AttestationVerificationInput, AttestationVerifier } from "./verifier.ts";

const SEPARATOR = Buffer.from([0x00]);

const ENVELOPE_FIELDS = ["schemaVersion", "provider", "environment", "purpose", "proof"] as const;

/**
 * Deterministic development-stub proof:
 *
 * `SHA-256(UTF8(domainSeparator) || 0x00 || ASCII(purpose) || 0x00 || clientDataHash)`
 *
 * The NUL separators are unambiguous because neither the domain separator nor a
 * purpose contains a NUL byte, and the client-data hash has a fixed length.
 */
export function computeDevelopmentStubProof(purpose: AttestationPurpose, clientDataHash: Uint8Array): Buffer {
  if (clientDataHash.byteLength !== CLIENT_DATA_HASH_BYTE_LENGTH) {
    throw new AttestationVerificationError(
      "E_INVALID_CLIENT_DATA_HASH",
      `The client-data hash must be exactly ${CLIENT_DATA_HASH_BYTE_LENGTH} bytes.`,
    );
  }

  return createHash("sha256")
    .update(Buffer.from(DEVELOPMENT_STUB_DOMAIN_SEPARATOR, "utf8"))
    .update(SEPARATOR)
    .update(Buffer.from(purpose, "ascii"))
    .update(SEPARATOR)
    .update(clientDataHash)
    .digest();
}

function malformedEnvelope(): AttestationVerificationError {
  return new AttestationVerificationError(
    "E_MALFORMED_ENVELOPE",
    "The attestation envelope does not have the expected shape.",
  );
}

/**
 * Accept only the exact canonical envelope: an object with the five known
 * fields, no extras, and the documented primitive types. Unknown fields are
 * rejected rather than ignored so a wire format change cannot pass unnoticed;
 * `schemaVersion` is what a later format is expected to move.
 */
export function parseAttestationEnvelope(value: unknown): AttestationEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedEnvelope();
  }

  const keys = Object.keys(value);
  if (keys.length !== ENVELOPE_FIELDS.length || !ENVELOPE_FIELDS.every((field) => Object.hasOwn(value, field))) {
    throw malformedEnvelope();
  }

  const { schemaVersion, provider, environment, purpose, proof } = value as Record<string, unknown>;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw malformedEnvelope();
  }
  if (
    typeof provider !== "string" ||
    typeof environment !== "string" ||
    typeof purpose !== "string" ||
    typeof proof !== "string"
  ) {
    throw malformedEnvelope();
  }

  return { schemaVersion, provider, environment, purpose, proof };
}

export interface DevelopmentStubAttestationVerifierOptions {
  readonly environmentSource?: EnvironmentSource;
  readonly logger?: AttestationWarningLogger;
}

/**
 * Verifier for the development-only stub.
 *
 * It carries no hardware assurance and exists so the iOS app and the server can
 * agree on the attestation boundary before real App Attest work lands. The
 * opt-in is re-read on every verification, so revoking the configuration
 * disables an already constructed verifier instead of leaving it armed.
 */
export class DevelopmentStubAttestationVerifier implements AttestationVerifier {
  readonly #environmentSource: EnvironmentSource;
  readonly #logger: AttestationWarningLogger;

  constructor(options: DevelopmentStubAttestationVerifierOptions = {}) {
    this.#environmentSource = options.environmentSource ?? process.env;
    this.#logger = options.logger ?? consoleAttestationWarningLogger;
  }

  verify(input: AttestationVerificationInput): AttestationVerificationResult {
    if (!evaluateDevelopmentStubEnablement(this.#environmentSource).enabled) {
      throw new AttestationVerificationError(
        "E_STUB_DISABLED",
        "The development attestation stub is not enabled for this process.",
      );
    }

    const expectedPurpose = input.expectedPurpose;
    if (!isAttestationPurpose(expectedPurpose)) {
      throw new AttestationVerificationError(
        "E_PURPOSE_MISMATCH",
        "The expected purpose is not a supported attestation purpose.",
      );
    }

    const expectedClientDataHash = input.expectedClientDataHash;
    if (
      !(expectedClientDataHash instanceof Uint8Array) ||
      expectedClientDataHash.byteLength !== CLIENT_DATA_HASH_BYTE_LENGTH
    ) {
      throw new AttestationVerificationError(
        "E_INVALID_CLIENT_DATA_HASH",
        `The expected client-data hash must be exactly ${CLIENT_DATA_HASH_BYTE_LENGTH} bytes.`,
      );
    }

    const envelope = parseAttestationEnvelope(input.envelope);

    if (envelope.schemaVersion !== ATTESTATION_SCHEMA_VERSION) {
      throw new AttestationVerificationError(
        "E_UNSUPPORTED_SCHEMA_VERSION",
        "The attestation envelope uses an unsupported schema version.",
      );
    }
    if (envelope.provider !== DEVELOPMENT_STUB_PROVIDER) {
      throw new AttestationVerificationError(
        "E_UNSUPPORTED_PROVIDER",
        "The attestation envelope was not produced by the development stub.",
      );
    }
    if (envelope.environment !== DEVELOPMENT_ENVIRONMENT) {
      throw new AttestationVerificationError(
        "E_FORBIDDEN_ENVIRONMENT",
        "The development stub only accepts development envelopes.",
      );
    }
    // `expectedPurpose` is already known to be supported, so equality also
    // proves the envelope purpose is one of the supported values.
    if (envelope.purpose !== expectedPurpose) {
      throw new AttestationVerificationError(
        "E_PURPOSE_MISMATCH",
        "The attestation envelope was not bound to the expected purpose.",
      );
    }

    const proof = decodeBase64UrlStrict(envelope.proof, PROOF_BYTE_LENGTH);
    if (proof === undefined) {
      throw new AttestationVerificationError(
        "E_INVALID_PROOF",
        "The attestation proof is not canonical unpadded base64url of the expected length.",
      );
    }

    // Both buffers are exactly PROOF_BYTE_LENGTH bytes, so `timingSafeEqual`
    // cannot throw on a length mismatch and the comparison stays constant time.
    const expectedProof = computeDevelopmentStubProof(expectedPurpose, expectedClientDataHash);
    if (!timingSafeEqual(proof, expectedProof)) {
      throw new AttestationVerificationError("E_INVALID_PROOF", "The attestation proof did not match.");
    }

    this.#logger.warn(developmentStubAcceptedWarning(expectedPurpose));

    return {
      provider: DEVELOPMENT_STUB_PROVIDER,
      environment: DEVELOPMENT_ENVIRONMENT,
      purpose: expectedPurpose,
      assurance: DEVELOPMENT_STUB_ASSURANCE,
    };
  }
}
