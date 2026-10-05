import { randomBytes, randomUUID } from "node:crypto";
import type { AppAttestChallengePurpose, IssuedAppAttestChallenge } from "../../src/app-attest-gate.ts";
import type { VerifiedAppAttestKey } from "../../src/app-attest.ts";
import type { EnrollmentAttestationGate } from "../../src/observer-enrollment.ts";

export class FakeEnrollmentGate implements EnrollmentAttestationGate {
  readonly keys = new Map<string, VerifiedAppAttestKey>();
  readonly challenges = new Map<string, { purpose: AppAttestChallengePurpose; key?: string }>();

  issueChallenge(purpose: AppAttestChallengePurpose, keyID?: string): IssuedAppAttestChallenge {
    const id = randomUUID();
    this.challenges.set(id, { purpose, ...(keyID === undefined ? {} : { key: keyID }) });
    return { id, bytes: randomBytes(32), expiresAt: Date.now() + 300_000 };
  }

  acceptAttestation(id: string, keyID: string, value: Uint8Array): VerifiedAppAttestKey {
    this.consume(id, "attestation", undefined, value);
    const key: VerifiedAppAttestKey = { keyID, publicKeyPem: "test", appID: "test", environment: "development", counter: 0 };
    this.keys.set(keyID, key);
    return key;
  }

  acceptAssertion(id: string, keyID: string, value: Uint8Array): VerifiedAppAttestKey {
    this.consume(id, "assertion", keyID, value);
    const key = this.keys.get(keyID);
    if (!key) throw Error("Missing key");
    const updated = { ...key, counter: key.counter + 1 };
    this.keys.set(keyID, updated);
    return updated;
  }

  getKey(keyID: string): VerifiedAppAttestKey | undefined { return this.keys.get(keyID); }

  consume(id: string, purpose: AppAttestChallengePurpose, keyID: string | undefined, value: Uint8Array): void {
    const challenge = this.challenges.get(id);
    this.challenges.delete(id);
    if (challenge?.purpose !== purpose || challenge.key !== keyID || value[0] !== 42) throw Error("Invalid evidence");
  }
}
