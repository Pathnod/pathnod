import { readFileSync } from "node:fs";

import { decodeBase64UrlStrict } from "../src/base64url.ts";
import { CLIENT_DATA_HASH_BYTE_LENGTH } from "../src/contract.ts";
import type { AttestationEnvelope, AttestationPurpose, EnvironmentSource } from "../src/contract.ts";
import { ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE, NODE_ENVIRONMENT_VARIABLE } from "../src/configuration.ts";
import { DEVELOPMENT_STUB_PROVIDER } from "../src/contract.ts";
import type { AttestationWarningEvent, AttestationWarningLogger } from "../src/logging.ts";

/**
 * The fixture is the artifact shared with the Swift package under `apps/ios`.
 * Both test suites read this one file so the two implementations cannot drift.
 */
const FIXTURE_URL = new URL("../../../fixtures/attestation/development-stub-v1.json", import.meta.url);

export interface FixtureVector {
  readonly name: string;
  readonly purpose: AttestationPurpose;
  readonly clientDataHash: string;
  readonly envelope: AttestationEnvelope;
}

export interface FixtureRejectedProof {
  readonly name: string;
  readonly purpose: AttestationPurpose;
  readonly clientDataHash: string;
  readonly proof: string;
  readonly reason: string;
}

export interface AttestationFixture {
  readonly description: string;
  readonly schemaVersion: number;
  readonly provider: string;
  readonly environment: string;
  readonly assurance: string;
  readonly domainSeparator: string;
  readonly clientDataHashByteLength: number;
  readonly proofByteLength: number;
  readonly encoding: string;
  readonly proofDefinition: string;
  readonly vectors: readonly FixtureVector[];
  readonly rejectedProofs: readonly FixtureRejectedProof[];
}

export const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as AttestationFixture;

export function fixtureVector(name: string): FixtureVector {
  const vector = fixture.vectors.find((candidate) => candidate.name === name);
  if (vector === undefined) {
    throw new Error(`The attestation fixture has no vector named ${name}.`);
  }
  return vector;
}

export function decodeFixtureClientDataHash(encoded: string): Buffer {
  const decoded = decodeBase64UrlStrict(encoded, CLIENT_DATA_HASH_BYTE_LENGTH);
  if (decoded === undefined) {
    throw new Error("The attestation fixture holds a non-canonical client-data hash.");
  }
  return decoded;
}

/** Minimal environment that opts into the stub. */
export const enabledEnvironment: EnvironmentSource = {
  [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
  [NODE_ENVIRONMENT_VARIABLE]: "development",
};

export const productionEnvironment: EnvironmentSource = {
  [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
  [NODE_ENVIRONMENT_VARIABLE]: "production",
};

export interface RecordingLogger {
  readonly logger: AttestationWarningLogger;
  readonly events: AttestationWarningEvent[];
}

export function createRecordingLogger(): RecordingLogger {
  const events: AttestationWarningEvent[] = [];
  return {
    events,
    logger: {
      warn(event: AttestationWarningEvent): void {
        events.push(event);
      },
    },
  };
}
