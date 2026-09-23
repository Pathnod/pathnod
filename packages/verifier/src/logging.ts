import { DEVELOPMENT_ENVIRONMENT, DEVELOPMENT_STUB_ASSURANCE, DEVELOPMENT_STUB_PROVIDER } from "./contract.ts";
import type { AttestationPurpose } from "./contract.ts";

/**
 * Structured warning emitted every time the development stub is accepted.
 *
 * The event deliberately carries provider metadata and the purpose only. It
 * must never grow a field holding a client-data hash, a proof, a full envelope,
 * an App Attest key identifier, a device identifier or any other private
 * material.
 */
export interface AttestationWarningEvent {
  readonly event: "development_stub_attestation_accepted";
  readonly message: string;
  readonly provider: string;
  readonly environment: string;
  readonly assurance: string;
  readonly purpose: AttestationPurpose;
}

export interface AttestationWarningLogger {
  warn(event: AttestationWarningEvent): void;
}

const WARNING_MESSAGE =
  "DEVELOPMENT ONLY: accepted a development-stub attestation. It provides no hardware assurance.";

export function developmentStubAcceptedWarning(purpose: AttestationPurpose): AttestationWarningEvent {
  return {
    event: "development_stub_attestation_accepted",
    message: WARNING_MESSAGE,
    provider: DEVELOPMENT_STUB_PROVIDER,
    environment: DEVELOPMENT_ENVIRONMENT,
    assurance: DEVELOPMENT_STUB_ASSURANCE,
    purpose,
  };
}

/**
 * Default logger. Fields are copied one by one instead of spreading the event,
 * so a future extra field cannot leak into the log without an explicit change
 * here.
 */
export const consoleAttestationWarningLogger: AttestationWarningLogger = {
  warn(event: AttestationWarningEvent): void {
    console.warn(event.message, {
      event: event.event,
      provider: event.provider,
      environment: event.environment,
      assurance: event.assurance,
      purpose: event.purpose,
    });
  },
};
