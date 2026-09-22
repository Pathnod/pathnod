import {
  ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE,
  evaluateDevelopmentStubEnablement,
} from "./configuration.ts";
import type { DevelopmentStubRejectionReason } from "./configuration.ts";
import { DEVELOPMENT_STUB_PROVIDER } from "./contract.ts";
import type { EnvironmentSource } from "./contract.ts";
import { DevelopmentStubAttestationVerifier } from "./development-stub.ts";
import { AttestationConfigurationError } from "./errors.ts";
import { consoleAttestationWarningLogger } from "./logging.ts";
import type { AttestationWarningLogger } from "./logging.ts";
import type { AttestationVerifier } from "./verifier.ts";

export interface CreateAttestationVerifierOptions {
  /** Defaults to `process.env`. */
  readonly environmentSource?: EnvironmentSource;
  readonly logger?: AttestationWarningLogger;
}

function configurationErrorFor(reason: DevelopmentStubRejectionReason): AttestationConfigurationError {
  switch (reason) {
    case "missing_configuration":
      return new AttestationConfigurationError(
        "E_MISSING_PROVIDER_CONFIGURATION",
        `${ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE} is not set. There is no default attestation provider.`,
      );
    case "unknown_provider":
      return new AttestationConfigurationError(
        "E_UNKNOWN_PROVIDER",
        `${ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE} does not name a supported attestation provider.`,
      );
    case "forbidden_environment":
      return new AttestationConfigurationError(
        "E_STUB_FORBIDDEN_ENVIRONMENT",
        `The ${DEVELOPMENT_STUB_PROVIDER} provider requires an explicit development or test environment.`,
      );
  }
}

/**
 * Build the configured verifier, or fail.
 *
 * There is no default and no fallback: an unset, unknown or production
 * configuration throws here, at startup, rather than downgrading a request path
 * to the stub later on. A future real provider must be selected by its own
 * identifier and, when it fails, propagate that failure instead of returning
 * the stub.
 */
export function createAttestationVerifier(options: CreateAttestationVerifierOptions = {}): AttestationVerifier {
  const environmentSource = options.environmentSource ?? process.env;
  const logger = options.logger ?? consoleAttestationWarningLogger;

  const enablement = evaluateDevelopmentStubEnablement(environmentSource);
  if (!enablement.enabled) {
    throw configurationErrorFor(enablement.reason);
  }

  return new DevelopmentStubAttestationVerifier({ environmentSource, logger });
}
