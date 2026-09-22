import type { AttestationPurpose, AttestationVerificationResult } from "./contract.ts";

export interface AttestationVerificationInput {
  /** Untrusted envelope, typically parsed from a request body. */
  readonly envelope: unknown;
  /** Purpose the caller expects, decided by the endpoint and not by the envelope. */
  readonly expectedPurpose: AttestationPurpose;
  /**
   * Client-data hash the caller recomputed itself. A hash carried by the
   * envelope would prove nothing, so the envelope does not carry one.
   */
  readonly expectedClientDataHash: Uint8Array;
}

export interface AttestationVerifier {
  /** Throws `AttestationVerificationError` on every failure. */
  verify(input: AttestationVerificationInput): AttestationVerificationResult;
}
