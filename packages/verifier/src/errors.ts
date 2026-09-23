/**
 * Typed failures. Later endpoints may map every verification failure to a
 * single public code such as `E_ASSERTION` while keeping these codes internal.
 *
 * Error messages never echo envelope fields, client-data hashes or proofs.
 */

export const ATTESTATION_VERIFICATION_ERROR_CODES = [
  "E_MALFORMED_ENVELOPE",
  "E_UNSUPPORTED_SCHEMA_VERSION",
  "E_UNSUPPORTED_PROVIDER",
  "E_FORBIDDEN_ENVIRONMENT",
  "E_PURPOSE_MISMATCH",
  "E_INVALID_CLIENT_DATA_HASH",
  "E_INVALID_PROOF",
  "E_STUB_DISABLED",
] as const;

export type AttestationVerificationErrorCode = (typeof ATTESTATION_VERIFICATION_ERROR_CODES)[number];

export class AttestationVerificationError extends Error {
  readonly code: AttestationVerificationErrorCode;

  constructor(code: AttestationVerificationErrorCode, message: string) {
    super(message);
    this.name = "AttestationVerificationError";
    this.code = code;
  }
}

export const ATTESTATION_CONFIGURATION_ERROR_CODES = [
  "E_MISSING_PROVIDER_CONFIGURATION",
  "E_UNKNOWN_PROVIDER",
  "E_STUB_FORBIDDEN_ENVIRONMENT",
] as const;

export type AttestationConfigurationErrorCode = (typeof ATTESTATION_CONFIGURATION_ERROR_CODES)[number];

export class AttestationConfigurationError extends Error {
  readonly code: AttestationConfigurationErrorCode;

  constructor(code: AttestationConfigurationErrorCode, message: string) {
    super(message);
    this.name = "AttestationConfigurationError";
    this.code = code;
  }
}
