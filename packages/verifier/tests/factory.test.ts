import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE, NODE_ENVIRONMENT_VARIABLE } from "../src/configuration.ts";
import { DEVELOPMENT_STUB_ASSURANCE, DEVELOPMENT_STUB_PROVIDER } from "../src/contract.ts";
import type { EnvironmentSource } from "../src/contract.ts";
import { DevelopmentStubAttestationVerifier } from "../src/development-stub.ts";
import { AttestationConfigurationError } from "../src/errors.ts";
import type { AttestationConfigurationErrorCode } from "../src/errors.ts";
import { createAttestationVerifier } from "../src/factory.ts";
import { createRecordingLogger, decodeFixtureClientDataHash, enabledEnvironment, fixtureVector } from "./fixture.ts";

function assertFailsWith(code: AttestationConfigurationErrorCode, environmentSource: EnvironmentSource): void {
  assert.throws(
    () => createAttestationVerifier({ environmentSource }),
    (error: unknown) => {
      assert.ok(error instanceof AttestationConfigurationError, `expected an AttestationConfigurationError, got ${error}`);
      assert.equal(error.code, code);
      return true;
    },
  );
}

describe("createAttestationVerifier", () => {
  it("builds the development stub when the opt-in is explicit", () => {
    const { logger } = createRecordingLogger();

    const verifier = createAttestationVerifier({ environmentSource: enabledEnvironment, logger });

    assert.ok(verifier instanceof DevelopmentStubAttestationVerifier);
  });

  it("produces a verifier that accepts the canonical enrollment vector", () => {
    const { logger, events } = createRecordingLogger();
    const vector = fixtureVector("enrollment-zeroed-client-data-hash");

    const result = createAttestationVerifier({ environmentSource: enabledEnvironment, logger }).verify({
      envelope: vector.envelope,
      expectedPurpose: vector.purpose,
      expectedClientDataHash: decodeFixtureClientDataHash(vector.clientDataHash),
    });

    assert.equal(result.assurance, DEVELOPMENT_STUB_ASSURANCE);
    assert.equal(events.length, 1);
  });

  it("fails when no provider is configured", () => {
    assertFailsWith("E_MISSING_PROVIDER_CONFIGURATION", {});
    assertFailsWith("E_MISSING_PROVIDER_CONFIGURATION", { [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: "" });
    assertFailsWith("E_MISSING_PROVIDER_CONFIGURATION", { [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: undefined });
  });

  it("fails on an unknown provider instead of falling back to the stub", () => {
    for (const value of ["app_attest", "none", "stub", "development-stub", "DEVELOPMENT_STUB", " development_stub "]) {
      assertFailsWith("E_UNKNOWN_PROVIDER", { [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: value });
    }
  });

  it("refuses the stub in production", () => {
    assertFailsWith("E_STUB_FORBIDDEN_ENVIRONMENT", {
      [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
      [NODE_ENVIRONMENT_VARIABLE]: "production",
    });
  });

  it("allows only explicit development and test node environments", () => {
    for (const nodeEnvironment of ["development", "test"]) {
      const verifier = createAttestationVerifier({
        environmentSource: {
          [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
          [NODE_ENVIRONMENT_VARIABLE]: nodeEnvironment,
        },
      });

      assert.ok(verifier instanceof DevelopmentStubAttestationVerifier);
    }

    for (const nodeEnvironment of [undefined, "", "staging", "Production", "prod"]) {
      assertFailsWith("E_STUB_FORBIDDEN_ENVIRONMENT", {
        [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
        [NODE_ENVIRONMENT_VARIABLE]: nodeEnvironment,
      });
    }
  });

  it("never echoes the configured value in its error messages", () => {
    const value = "a-value-that-should-not-be-echoed";

    assert.throws(
      () => createAttestationVerifier({ environmentSource: { [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: value } }),
      (error: unknown) => {
        assert.ok(error instanceof AttestationConfigurationError);
        assert.ok(!error.message.includes(value));
        return true;
      },
    );
  });
});
