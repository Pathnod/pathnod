import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEVELOPMENT_ENVIRONMENT, DEVELOPMENT_STUB_ASSURANCE, DEVELOPMENT_STUB_PROVIDER } from "../src/contract.ts";
import { DevelopmentStubAttestationVerifier } from "../src/development-stub.ts";
import { consoleAttestationWarningLogger, developmentStubAcceptedWarning } from "../src/logging.ts";
import { createRecordingLogger, decodeFixtureClientDataHash, enabledEnvironment, fixture } from "./fixture.ts";

describe("developmentStubAcceptedWarning", () => {
  it("names the provider, environment, assurance and purpose", () => {
    const event = developmentStubAcceptedWarning("observation");

    assert.deepEqual(event, {
      event: "development_stub_attestation_accepted",
      message: event.message,
      provider: DEVELOPMENT_STUB_PROVIDER,
      environment: DEVELOPMENT_ENVIRONMENT,
      assurance: DEVELOPMENT_STUB_ASSURANCE,
      purpose: "observation",
    });
  });

  it("carries a message that is unmistakably development-only", () => {
    const event = developmentStubAcceptedWarning("enrollment");

    assert.match(event.message, /DEVELOPMENT ONLY/);
    assert.match(event.message, /no hardware assurance/);
  });
});

describe("consoleAttestationWarningLogger", () => {
  it("writes the warning through console.warn", (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);

    consoleAttestationWarningLogger.warn(developmentStubAcceptedWarning("enrollment"));

    assert.equal(warn.mock.callCount(), 1);
    const call = warn.mock.calls[0];
    assert.ok(call !== undefined);
    assert.deepEqual(call.arguments[1], {
      event: "development_stub_attestation_accepted",
      provider: DEVELOPMENT_STUB_PROVIDER,
      environment: DEVELOPMENT_ENVIRONMENT,
      assurance: DEVELOPMENT_STUB_ASSURANCE,
      purpose: "enrollment",
    });
  });

  it("copies known fields only, so an extended event cannot leak", (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const event = {
      ...developmentStubAcceptedWarning("enrollment"),
      proof: "WcbN5PyXCKC4F3bowF2AqxuFzHSpApZGm0lMY6c7NYc",
      clientDataHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };

    consoleAttestationWarningLogger.warn(event);

    assert.equal(JSON.stringify(warn.mock.calls[0]?.arguments).includes("WcbN5"), false);
  });
});

describe("development-stub warnings", () => {
  it("emits exactly one warning per accepted envelope and none per rejection", () => {
    const { logger, events } = createRecordingLogger();
    const verifier = new DevelopmentStubAttestationVerifier({ environmentSource: enabledEnvironment, logger });

    for (const vector of fixture.vectors) {
      verifier.verify({
        envelope: vector.envelope,
        expectedPurpose: vector.purpose,
        expectedClientDataHash: decodeFixtureClientDataHash(vector.clientDataHash),
      });
    }

    assert.equal(events.length, fixture.vectors.length);
    assert.deepEqual(
      events.map((event) => event.purpose),
      fixture.vectors.map((vector) => vector.purpose),
    );
  });

  it("never carries the client-data hash, the proof or the envelope", () => {
    const { logger, events } = createRecordingLogger();
    const verifier = new DevelopmentStubAttestationVerifier({ environmentSource: enabledEnvironment, logger });

    for (const vector of fixture.vectors) {
      verifier.verify({
        envelope: vector.envelope,
        expectedPurpose: vector.purpose,
        expectedClientDataHash: decodeFixtureClientDataHash(vector.clientDataHash),
      });
    }

    const serialized = JSON.stringify(events);
    for (const vector of fixture.vectors) {
      assert.equal(serialized.includes(vector.envelope.proof), false);
      assert.equal(serialized.includes(vector.clientDataHash), false);
    }
  });
});
