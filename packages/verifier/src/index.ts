export { decodeBase64UrlStrict, encodeBase64Url } from "./base64url.ts";

export {
  ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE,
  DEVELOPMENT_STUB_ALLOWED_NODE_ENVIRONMENTS,
  NODE_ENVIRONMENT_VARIABLE,
  PRODUCTION_NODE_ENVIRONMENT,
  evaluateDevelopmentStubEnablement,
} from "./configuration.ts";
export type { DevelopmentStubEnablement, DevelopmentStubRejectionReason } from "./configuration.ts";

export {
  ATTESTATION_PURPOSES,
  ATTESTATION_SCHEMA_VERSION,
  CLIENT_DATA_HASH_BYTE_LENGTH,
  DEVELOPMENT_ENVIRONMENT,
  DEVELOPMENT_STUB_ASSURANCE,
  DEVELOPMENT_STUB_DOMAIN_SEPARATOR,
  DEVELOPMENT_STUB_PROVIDER,
  PROOF_BYTE_LENGTH,
  isAttestationPurpose,
} from "./contract.ts";
export type {
  AttestationEnvelope,
  AttestationPurpose,
  AttestationVerificationResult,
  EnvironmentSource,
} from "./contract.ts";

export {
  DevelopmentStubAttestationVerifier,
  computeDevelopmentStubProof,
  parseAttestationEnvelope,
} from "./development-stub.ts";
export type { DevelopmentStubAttestationVerifierOptions } from "./development-stub.ts";

export {
  ATTESTATION_CONFIGURATION_ERROR_CODES,
  ATTESTATION_VERIFICATION_ERROR_CODES,
  AttestationConfigurationError,
  AttestationVerificationError,
} from "./errors.ts";
export type { AttestationConfigurationErrorCode, AttestationVerificationErrorCode } from "./errors.ts";

export { createAttestationVerifier } from "./factory.ts";
export type { CreateAttestationVerifierOptions } from "./factory.ts";

export { consoleAttestationWarningLogger, developmentStubAcceptedWarning } from "./logging.ts";
export type { AttestationWarningEvent, AttestationWarningLogger } from "./logging.ts";

export type { AttestationVerificationInput, AttestationVerifier } from "./verifier.ts";
