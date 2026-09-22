import { DEVELOPMENT_STUB_PROVIDER } from "./contract.ts";
import type { EnvironmentSource } from "./contract.ts";

/** Opt-in variable read by the factory and re-read by the stub verifier. */
export const ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE = "PATHNOD_ATTESTATION_PROVIDER";

export const NODE_ENVIRONMENT_VARIABLE = "NODE_ENV";

export const PRODUCTION_NODE_ENVIRONMENT = "production";

export const DEVELOPMENT_STUB_ALLOWED_NODE_ENVIRONMENTS = ["development", "test"] as const;

export type DevelopmentStubRejectionReason =
  | "missing_configuration"
  | "unknown_provider"
  | "forbidden_environment";

export type DevelopmentStubEnablement =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: DevelopmentStubRejectionReason };

/**
 * Read one variable, ignoring anything reached through the prototype chain.
 *
 * Only an own property is an opt-in. A value inherited from an
 * `Object.create(...)` prototype or from a polluted `Object.prototype` was
 * never set on the environment itself, so it must read as unset.
 */
function readOwnEnvironmentValue(source: EnvironmentSource, name: string): string | undefined {
  return Object.hasOwn(source, name) ? source[name] : undefined;
}

/**
 * Decide whether the development stub may run.
 *
 * The check is explicit and fails closed: there is no default provider, the
 * opt-in value must match exactly, it must be set on the environment itself
 * rather than inherited, and only explicit development/test Node environments
 * are accepted. The
 * factory and the verifier share this single decision so a verifier can never
 * be more permissive than the configuration that built it.
 */
export function evaluateDevelopmentStubEnablement(source: EnvironmentSource): DevelopmentStubEnablement {
  const configured = readOwnEnvironmentValue(source, ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE);

  if (configured === undefined || configured === "") {
    return { enabled: false, reason: "missing_configuration" };
  }
  if (configured !== DEVELOPMENT_STUB_PROVIDER) {
    return { enabled: false, reason: "unknown_provider" };
  }
  const nodeEnvironment = readOwnEnvironmentValue(source, NODE_ENVIRONMENT_VARIABLE);
  if (!(DEVELOPMENT_STUB_ALLOWED_NODE_ENVIRONMENTS as readonly (string | undefined)[]).includes(nodeEnvironment)) {
    return { enabled: false, reason: "forbidden_environment" };
  }

  return { enabled: true };
}
