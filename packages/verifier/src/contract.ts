/**
 * Attestation contract shared with the Swift provider package under `apps/ios`
 * and with `fixtures/attestation/development-stub-v1.json`.
 *
 * The contract is duplicated per language on purpose: the fixture is the shared
 * artifact, not the source code.
 */

/** Only schema version 1 exists today. */
export const ATTESTATION_SCHEMA_VERSION = 1;

/** Opt-in identifier of the development-only stub. There is no default provider. */
export const DEVELOPMENT_STUB_PROVIDER = "development_stub";

/** The only environment the development stub may run in. */
export const DEVELOPMENT_ENVIRONMENT = "development";

/** The development stub carries no hardware assurance whatsoever. */
export const DEVELOPMENT_STUB_ASSURANCE = "none";

/** Domain separator of the deterministic development-stub proof. */
export const DEVELOPMENT_STUB_DOMAIN_SEPARATOR = "Pathnod/development-stub-attestation/v1";

/** Client-data hashes are always SHA-256 digests. */
export const CLIENT_DATA_HASH_BYTE_LENGTH = 32;

/** Development-stub proofs are SHA-256 digests. */
export const PROOF_BYTE_LENGTH = 32;

export const ATTESTATION_PURPOSES = ["enrollment", "observation"] as const;

export type AttestationPurpose = (typeof ATTESTATION_PURPOSES)[number];

export function isAttestationPurpose(value: unknown): value is AttestationPurpose {
  return typeof value === "string" && (ATTESTATION_PURPOSES as readonly string[]).includes(value);
}

/** Envelope produced by a provider, transported as JSON. */
export interface AttestationEnvelope {
  readonly schemaVersion: number;
  readonly provider: string;
  readonly environment: string;
  readonly purpose: string;
  readonly proof: string;
}

/** Result of a successful verification. */
export interface AttestationVerificationResult {
  readonly provider: string;
  readonly environment: string;
  readonly purpose: AttestationPurpose;
  readonly assurance: string;
}

/** Process environment as read by the factory and by the stub verifier. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;
