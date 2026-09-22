import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE,
  NODE_ENVIRONMENT_VARIABLE,
  evaluateDevelopmentStubEnablement,
} from "../src/configuration.ts";
import { DEVELOPMENT_STUB_ASSURANCE, DEVELOPMENT_STUB_PROVIDER } from "../src/contract.ts";
import type { EnvironmentSource } from "../src/contract.ts";
import { DevelopmentStubAttestationVerifier } from "../src/development-stub.ts";
import { AttestationConfigurationError, AttestationVerificationError } from "../src/errors.ts";
import type { AttestationConfigurationErrorCode } from "../src/errors.ts";
import { createAttestationVerifier } from "../src/factory.ts";
import type { AttestationVerificationInput } from "../src/verifier.ts";
import { createRecordingLogger, decodeFixtureClientDataHash, fixtureVector } from "./fixture.ts";

const enrollment = fixtureVector("enrollment-zeroed-client-data-hash");

function verificationInput(): AttestationVerificationInput {
  return {
    envelope: enrollment.envelope,
    expectedPurpose: enrollment.purpose,
    expectedClientDataHash: decodeFixtureClientDataHash(enrollment.clientDataHash),
  };
}

/**
 * Run `body` with the given keys planted on `Object.prototype`, then restore it
 * whatever happens: a failing assertion must not leak a polluted prototype into
 * the rest of the suite.
 */
function withPollutedObjectPrototype(values: Readonly<Record<string, string>>, body: () => void): void {
  const prototype = Object.prototype;
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

  try {
    for (const [name, value] of Object.entries(values)) {
      originalDescriptors.set(name, Object.getOwnPropertyDescriptor(prototype, name));
      Object.defineProperty(prototype, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    body();
  } finally {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor === undefined) {
        delete (prototype as unknown as Record<string, unknown>)[name];
      } else {
        Object.defineProperty(prototype, name, descriptor);
      }
    }
  }
}

/** Same idea for the real `process.env`, which the factory reads by default. */
function withoutOwnProcessEnvironmentVariables(names: readonly string[], body: () => void): void {
  const saved = new Map<string, string | undefined>();

  try {
    for (const name of names) {
      if (Object.hasOwn(process.env, name)) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
    }
    body();
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  }
}

/** Temporarily set own values on the real `process.env`, restoring prior state. */
function withOwnProcessEnvironmentVariables(values: Readonly<Record<string, string>>, body: () => void): void {
  const saved = new Map<string, { readonly hadOwn: boolean; readonly value: string | undefined }>();

  try {
    for (const [name, value] of Object.entries(values)) {
      saved.set(name, { hadOwn: Object.hasOwn(process.env, name), value: process.env[name] });
      process.env[name] = value;
    }
    body();
  } finally {
    for (const [name, previous] of saved) {
      if (previous.hadOwn && previous.value !== undefined) {
        process.env[name] = previous.value;
      } else {
        delete process.env[name];
      }
    }
  }
}

function assertConfigurationFails(
  code: AttestationConfigurationErrorCode,
  environmentSource: EnvironmentSource,
): void {
  assert.throws(
    () => createAttestationVerifier({ environmentSource }),
    (error: unknown) => {
      assert.ok(error instanceof AttestationConfigurationError, `expected an AttestationConfigurationError, got ${error}`);
      assert.equal(error.code, code);
      return true;
    },
  );
}

describe("evaluateDevelopmentStubEnablement", () => {
  it("ignores a provider inherited from a prototype", () => {
    const environmentSource: EnvironmentSource = Object.create({
      [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
      [NODE_ENVIRONMENT_VARIABLE]: "development",
    }) as EnvironmentSource;

    assert.deepEqual(evaluateDevelopmentStubEnablement(environmentSource), {
      enabled: false,
      reason: "missing_configuration",
    });
    assertConfigurationFails("E_MISSING_PROVIDER_CONFIGURATION", environmentSource);
  });

  it("ignores a node environment inherited from a prototype", () => {
    const environmentSource: EnvironmentSource = Object.assign(
      Object.create({ [NODE_ENVIRONMENT_VARIABLE]: "development" }) as EnvironmentSource,
      { [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER },
    );

    assert.deepEqual(evaluateDevelopmentStubEnablement(environmentSource), {
      enabled: false,
      reason: "forbidden_environment",
    });
    assertConfigurationFails("E_STUB_FORBIDDEN_ENVIRONMENT", environmentSource);
  });

  it("still reads own values set on an inheriting environment", () => {
    const environmentSource: EnvironmentSource = Object.assign(
      Object.create({ [NODE_ENVIRONMENT_VARIABLE]: "production" }) as EnvironmentSource,
      {
        [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
        [NODE_ENVIRONMENT_VARIABLE]: "test",
      },
    );

    assert.deepEqual(evaluateDevelopmentStubEnablement(environmentSource), { enabled: true });
  });

  it("ignores an opt-in planted on Object.prototype", () => {
    withPollutedObjectPrototype(
      {
        [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
        [NODE_ENVIRONMENT_VARIABLE]: "development",
      },
      () => {
        assert.deepEqual(evaluateDevelopmentStubEnablement({}), {
          enabled: false,
          reason: "missing_configuration",
        });
        assertConfigurationFails("E_MISSING_PROVIDER_CONFIGURATION", {});
      },
    );
  });

  it("ignores a node environment planted on Object.prototype", () => {
    withPollutedObjectPrototype({ [NODE_ENVIRONMENT_VARIABLE]: "development" }, () => {
      assertConfigurationFails("E_STUB_FORBIDDEN_ENVIRONMENT", {
        [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
      });
    });
  });

  it("ignores an opt-in planted on Object.prototype when reading process.env", () => {
    withoutOwnProcessEnvironmentVariables([ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE, NODE_ENVIRONMENT_VARIABLE], () => {
      withPollutedObjectPrototype(
        {
          [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
          [NODE_ENVIRONMENT_VARIABLE]: "development",
        },
        () => {
          assert.deepEqual(evaluateDevelopmentStubEnablement(process.env), {
            enabled: false,
            reason: "missing_configuration",
          });
          assert.throws(
            () => createAttestationVerifier({ logger: createRecordingLogger().logger }),
            AttestationConfigurationError,
          );
        },
      );
    });
  });

  it("keeps supporting own opt-in values from process.env", () => {
    withOwnProcessEnvironmentVariables(
      {
        [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
        [NODE_ENVIRONMENT_VARIABLE]: "development",
      },
      () => {
        const verifier = createAttestationVerifier({ logger: createRecordingLogger().logger });

        assert.ok(verifier instanceof DevelopmentStubAttestationVerifier);
        assert.equal(verifier.verify(verificationInput()).assurance, DEVELOPMENT_STUB_ASSURANCE);
      },
    );
  });

  it("keeps revoking an own opt-in effective under prototype pollution", () => {
    const environmentSource: Record<string, string | undefined> = {
      [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
      [NODE_ENVIRONMENT_VARIABLE]: "development",
    };
    const { logger } = createRecordingLogger();
    const verifier = new DevelopmentStubAttestationVerifier({ environmentSource, logger });
    const input = verificationInput();

    assert.equal(verifier.verify(input).assurance, DEVELOPMENT_STUB_ASSURANCE);

    withPollutedObjectPrototype(
      {
        [ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE]: DEVELOPMENT_STUB_PROVIDER,
        [NODE_ENVIRONMENT_VARIABLE]: "development",
      },
      () => {
        delete environmentSource[ATTESTATION_PROVIDER_ENVIRONMENT_VARIABLE];

        assert.throws(
          () => verifier.verify(input),
          (error: unknown) => {
            assert.ok(error instanceof AttestationVerificationError, `expected an AttestationVerificationError, got ${error}`);
            assert.equal(error.code, "E_STUB_DISABLED");
            return true;
          },
        );
      },
    );
  });
});
