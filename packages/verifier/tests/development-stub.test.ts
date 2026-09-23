import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeBase64Url } from "../src/base64url.ts";
import {
  ATTESTATION_SCHEMA_VERSION,
  CLIENT_DATA_HASH_BYTE_LENGTH,
  DEVELOPMENT_ENVIRONMENT,
  DEVELOPMENT_STUB_ASSURANCE,
  DEVELOPMENT_STUB_DOMAIN_SEPARATOR,
  DEVELOPMENT_STUB_PROVIDER,
  PROOF_BYTE_LENGTH,
} from "../src/contract.ts";
import type { AttestationEnvelope, AttestationPurpose } from "../src/contract.ts";
import {
  DevelopmentStubAttestationVerifier,
  computeDevelopmentStubProof,
} from "../src/development-stub.ts";
import { AttestationVerificationError } from "../src/errors.ts";
import type { AttestationVerificationErrorCode } from "../src/errors.ts";
import {
  createRecordingLogger,
  decodeFixtureClientDataHash,
  enabledEnvironment,
  fixture,
  fixtureVector,
  productionEnvironment,
} from "./fixture.ts";

function verifierWithRecordingLogger(): {
  readonly verifier: DevelopmentStubAttestationVerifier;
  readonly events: ReturnType<typeof createRecordingLogger>["events"];
} {
  const { logger, events } = createRecordingLogger();
  return {
    verifier: new DevelopmentStubAttestationVerifier({ environmentSource: enabledEnvironment, logger }),
    events,
  };
}

function assertFailsWith(code: AttestationVerificationErrorCode, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof AttestationVerificationError, `expected an AttestationVerificationError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const enrollment = fixtureVector("enrollment-zeroed-client-data-hash");

function enrollmentEnvelope(overrides: Partial<AttestationEnvelope> = {}): AttestationEnvelope {
  return { ...enrollment.envelope, ...overrides };
}

describe("attestation fixture", () => {
  it("describes the contract the verifier implements", () => {
    assert.equal(fixture.schemaVersion, ATTESTATION_SCHEMA_VERSION);
    assert.equal(fixture.provider, DEVELOPMENT_STUB_PROVIDER);
    assert.equal(fixture.environment, DEVELOPMENT_ENVIRONMENT);
    assert.equal(fixture.assurance, DEVELOPMENT_STUB_ASSURANCE);
    assert.equal(fixture.domainSeparator, DEVELOPMENT_STUB_DOMAIN_SEPARATOR);
    assert.equal(fixture.clientDataHashByteLength, CLIENT_DATA_HASH_BYTE_LENGTH);
    assert.equal(fixture.proofByteLength, PROOF_BYTE_LENGTH);
    assert.ok(fixture.vectors.length >= 2);
  });

  it("holds only documented fields, so no key or device identifier can hide in it", () => {
    assert.deepEqual(Object.keys(fixture).sort(), [
      "assurance",
      "clientDataHashByteLength",
      "description",
      "domainSeparator",
      "encoding",
      "environment",
      "proofByteLength",
      "proofDefinition",
      "provider",
      "rejectedProofs",
      "schemaVersion",
      "vectors",
    ]);

    for (const vector of fixture.vectors) {
      assert.deepEqual(Object.keys(vector).sort(), ["clientDataHash", "envelope", "name", "purpose"], vector.name);
      assert.deepEqual(
        Object.keys(vector.envelope).sort(),
        ["environment", "proof", "provider", "purpose", "schemaVersion"],
        vector.name,
      );
    }

    for (const rejected of fixture.rejectedProofs) {
      assert.deepEqual(
        Object.keys(rejected).sort(),
        ["clientDataHash", "name", "proof", "purpose", "reason"],
        rejected.name,
      );
    }
  });
});

describe("computeDevelopmentStubProof", () => {
  it("reproduces every canonical fixture vector", () => {
    for (const vector of fixture.vectors) {
      const clientDataHash = decodeFixtureClientDataHash(vector.clientDataHash);
      const proof = computeDevelopmentStubProof(vector.purpose, clientDataHash);

      assert.equal(proof.byteLength, PROOF_BYTE_LENGTH);
      assert.equal(encodeBase64Url(proof), vector.envelope.proof, vector.name);
    }
  });

  it("binds the proof to the purpose", () => {
    const clientDataHash = decodeFixtureClientDataHash(enrollment.clientDataHash);

    assert.notEqual(
      encodeBase64Url(computeDevelopmentStubProof("enrollment", clientDataHash)),
      encodeBase64Url(computeDevelopmentStubProof("observation", clientDataHash)),
    );
  });

  it("rejects a client-data hash of the wrong length", () => {
    assertFailsWith("E_INVALID_CLIENT_DATA_HASH", () =>
      computeDevelopmentStubProof("enrollment", new Uint8Array(CLIENT_DATA_HASH_BYTE_LENGTH - 1)),
    );
    assertFailsWith("E_INVALID_CLIENT_DATA_HASH", () =>
      computeDevelopmentStubProof("enrollment", new Uint8Array(CLIENT_DATA_HASH_BYTE_LENGTH + 1)),
    );
  });
});

describe("DevelopmentStubAttestationVerifier", () => {
  it("accepts every canonical fixture vector", () => {
    for (const vector of fixture.vectors) {
      const { verifier, events } = verifierWithRecordingLogger();

      const result = verifier.verify({
        envelope: vector.envelope,
        expectedPurpose: vector.purpose,
        expectedClientDataHash: decodeFixtureClientDataHash(vector.clientDataHash),
      });

      assert.deepEqual(result, {
        provider: DEVELOPMENT_STUB_PROVIDER,
        environment: DEVELOPMENT_ENVIRONMENT,
        purpose: vector.purpose,
        assurance: DEVELOPMENT_STUB_ASSURANCE,
      });
      assert.equal(events.length, 1, `${vector.name} emitted ${events.length} warnings`);
    }
  });

  it("accepts an envelope parsed from JSON", () => {
    const { verifier } = verifierWithRecordingLogger();

    const result = verifier.verify({
      envelope: JSON.parse(JSON.stringify(enrollment.envelope)),
      expectedPurpose: enrollment.purpose,
      expectedClientDataHash: decodeFixtureClientDataHash(enrollment.clientDataHash),
    });

    assert.equal(result.assurance, DEVELOPMENT_STUB_ASSURANCE);
  });

  it("rejects every proof the fixture marks as invalid", () => {
    for (const rejected of fixture.rejectedProofs) {
      const { verifier, events } = verifierWithRecordingLogger();

      assertFailsWith("E_INVALID_PROOF", () =>
        verifier.verify({
          envelope: {
            schemaVersion: ATTESTATION_SCHEMA_VERSION,
            provider: DEVELOPMENT_STUB_PROVIDER,
            environment: DEVELOPMENT_ENVIRONMENT,
            purpose: rejected.purpose,
            proof: rejected.proof,
          },
          expectedPurpose: rejected.purpose,
          expectedClientDataHash: decodeFixtureClientDataHash(rejected.clientDataHash),
        }),
      );
      assert.equal(events.length, 0, `${rejected.name} emitted an acceptance warning`);
    }
  });

  it("rejects a proof bound to a different client-data hash", () => {
    const { verifier } = verifierWithRecordingLogger();
    const other = fixtureVector("observation-counting-client-data-hash");

    assertFailsWith("E_INVALID_PROOF", () =>
      verifier.verify({
        envelope: enrollment.envelope,
        expectedPurpose: "enrollment",
        expectedClientDataHash: decodeFixtureClientDataHash(other.clientDataHash),
      }),
    );
  });

  it("rejects a proof whose first or last byte was flipped", () => {
    const clientDataHash = decodeFixtureClientDataHash(enrollment.clientDataHash);

    for (const index of [0, PROOF_BYTE_LENGTH - 1]) {
      const tampered = computeDevelopmentStubProof("enrollment", clientDataHash);
      tampered.writeUInt8(tampered.readUInt8(index) ^ 0x01, index);

      const { verifier } = verifierWithRecordingLogger();
      assertFailsWith("E_INVALID_PROOF", () =>
        verifier.verify({
          envelope: enrollmentEnvelope({ proof: encodeBase64Url(tampered) }),
          expectedPurpose: "enrollment",
          expectedClientDataHash: clientDataHash,
        }),
      );
    }
  });

  it("rejects a purpose mismatch", () => {
    const { verifier } = verifierWithRecordingLogger();
    const observation = fixtureVector("observation-counting-client-data-hash");

    assertFailsWith("E_PURPOSE_MISMATCH", () =>
      verifier.verify({
        envelope: observation.envelope,
        expectedPurpose: "enrollment",
        expectedClientDataHash: decodeFixtureClientDataHash(observation.clientDataHash),
      }),
    );
  });

  it("rejects an unsupported expected purpose", () => {
    const { verifier } = verifierWithRecordingLogger();

    assertFailsWith("E_PURPOSE_MISMATCH", () =>
      verifier.verify({
        envelope: enrollment.envelope,
        expectedPurpose: "payment" as unknown as AttestationPurpose,
        expectedClientDataHash: decodeFixtureClientDataHash(enrollment.clientDataHash),
      }),
    );
  });

  it("rejects an unsupported schema version", () => {
    const clientDataHash = decodeFixtureClientDataHash(enrollment.clientDataHash);

    for (const schemaVersion of [0, 2, -1]) {
      const { verifier } = verifierWithRecordingLogger();
      assertFailsWith("E_UNSUPPORTED_SCHEMA_VERSION", () =>
        verifier.verify({
          envelope: enrollmentEnvelope({ schemaVersion }),
          expectedPurpose: "enrollment",
          expectedClientDataHash: clientDataHash,
        }),
      );
    }
  });

  it("rejects an unsupported provider", () => {
    const { verifier } = verifierWithRecordingLogger();

    assertFailsWith("E_UNSUPPORTED_PROVIDER", () =>
      verifier.verify({
        envelope: enrollmentEnvelope({ provider: "app_attest" }),
        expectedPurpose: "enrollment",
        expectedClientDataHash: decodeFixtureClientDataHash(enrollment.clientDataHash),
      }),
    );
  });

  it("rejects a non-development environment", () => {
    const clientDataHash = decodeFixtureClientDataHash(enrollment.clientDataHash);

    for (const environment of ["production", "staging", "Development", ""]) {
      const { verifier } = verifierWithRecordingLogger();
      assertFailsWith("E_FORBIDDEN_ENVIRONMENT", () =>
        verifier.verify({
          envelope: enrollmentEnvelope({ environment }),
          expectedPurpose: "enrollment",
          expectedClientDataHash: clientDataHash,
        }),
      );
    }
  });

  it("rejects a malformed envelope", () => {
    const clientDataHash = decodeFixtureClientDataHash(enrollment.clientDataHash);
    const malformed: readonly unknown[] = [
      undefined,
      null,
      "",
      JSON.stringify(enrollment.envelope),
      42,
      [enrollment.envelope],
      {},
      { ...enrollment.envelope, extra: true },
      { ...enrollment.envelope, schemaVersion: "1" },
      { ...enrollment.envelope, schemaVersion: 1.5 },
      { ...enrollment.envelope, provider: 1 },
      { ...enrollment.envelope, environment: null },
      { ...enrollment.envelope, purpose: ["enrollment"] },
      { ...enrollment.envelope, proof: null },
      omit("proof"),
      omit("purpose"),
      omit("schemaVersion"),
    ];

    for (const envelope of malformed) {
      const { verifier } = verifierWithRecordingLogger();
      assertFailsWith("E_MALFORMED_ENVELOPE", () =>
        verifier.verify({ envelope, expectedPurpose: "enrollment", expectedClientDataHash: clientDataHash }),
      );
    }
  });

  it("rejects an expected client-data hash of the wrong type or length", () => {
    const invalid: readonly unknown[] = [
      undefined,
      null,
      new Uint8Array(CLIENT_DATA_HASH_BYTE_LENGTH - 1),
      new Uint8Array(CLIENT_DATA_HASH_BYTE_LENGTH + 1),
      new Uint8Array(0),
      enrollment.clientDataHash,
      Array.from({ length: CLIENT_DATA_HASH_BYTE_LENGTH }, () => 0),
      new ArrayBuffer(CLIENT_DATA_HASH_BYTE_LENGTH),
    ];

    for (const expectedClientDataHash of invalid) {
      const { verifier } = verifierWithRecordingLogger();
      assertFailsWith("E_INVALID_CLIENT_DATA_HASH", () =>
        verifier.verify({
          envelope: enrollment.envelope,
          expectedPurpose: "enrollment",
          expectedClientDataHash: expectedClientDataHash as Uint8Array,
        }),
      );
    }
  });

  it("fails closed when the opt-in is missing, unknown or production", () => {
    const clientDataHash = decodeFixtureClientDataHash(enrollment.clientDataHash);
    const environments = [
      {},
      { PATHNOD_ATTESTATION_PROVIDER: "" },
      { PATHNOD_ATTESTATION_PROVIDER: "app_attest" },
      { PATHNOD_ATTESTATION_PROVIDER: " development_stub" },
      { PATHNOD_ATTESTATION_PROVIDER: "DEVELOPMENT_STUB" },
      { PATHNOD_ATTESTATION_PROVIDER: "development_stub" },
      { PATHNOD_ATTESTATION_PROVIDER: "development_stub", NODE_ENV: "staging" },
      productionEnvironment,
    ];

    for (const environmentSource of environments) {
      const { logger, events } = createRecordingLogger();
      const verifier = new DevelopmentStubAttestationVerifier({ environmentSource, logger });

      assertFailsWith("E_STUB_DISABLED", () =>
        verifier.verify({
          envelope: enrollment.envelope,
          expectedPurpose: "enrollment",
          expectedClientDataHash: clientDataHash,
        }),
      );
      assert.equal(events.length, 0);
    }
  });

  it("stops accepting envelopes once the opt-in is revoked", () => {
    const environmentSource: Record<string, string | undefined> = {
      PATHNOD_ATTESTATION_PROVIDER: DEVELOPMENT_STUB_PROVIDER,
      NODE_ENV: "development",
    };
    const { logger } = createRecordingLogger();
    const verifier = new DevelopmentStubAttestationVerifier({ environmentSource, logger });
    const input = {
      envelope: enrollment.envelope,
      expectedPurpose: enrollment.purpose,
      expectedClientDataHash: decodeFixtureClientDataHash(enrollment.clientDataHash),
    };

    assert.equal(verifier.verify(input).assurance, DEVELOPMENT_STUB_ASSURANCE);

    delete environmentSource["PATHNOD_ATTESTATION_PROVIDER"];

    assertFailsWith("E_STUB_DISABLED", () => verifier.verify(input));
  });
});

function omit(field: keyof AttestationEnvelope): Record<string, unknown> {
  const envelope: Record<string, unknown> = { ...enrollment.envelope };
  delete envelope[field];
  return envelope;
}
