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
 * Report whether the process itself runs in production.
 *
 * This reads `process.env` on purpose and takes no source argument: an injected
 * environment is a convenience for deterministic tests, never a way to arm the
 * stub inside a production process. Keeping the guard out of reach of the
 * caller is what makes it independent from the configured environment.
 */
export function isAmbientProductionRuntime(): boolean {
  return readOwnEnvironmentValue(process.env, NODE_ENVIRONMENT_VARIABLE) === PRODUCTION_NODE_ENVIRONMENT;
}

/**
 * Decide whether the development stub may run.
 *
 * The check is explicit and fails closed: there is no default provider, the
 * opt-in value must match exactly, it must be set on the environment itself
 * rather than inherited, only explicit development/test Node environments are
 * accepted, and the running process must not itself be in production. The
 * factory and the verifier share this single decision so a verifier can never
 * be more permissive than the configuration that built it.
 */
export function evaluateDevelopmentStubEnablement(source: EnvironmentSource): DevelopmentStubEnablement {
  // Check before touching the injected source. Besides making the runtime guard
  // independent, this prevents a getter or Proxy supplied as the source from
  // weakening an already-production process as a side effect of being read.
  if (isAmbientProductionRuntime()) {
    return { enabled: false, reason: "forbidden_environment" };
  }

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
  // Check again after reading the injected source so a side effect cannot move
  // the process into production and still permit one verification.
  if (isAmbientProductionRuntime()) {
    return { enabled: false, reason: "forbidden_environment" };
  }

  return { enabled: true };
}
