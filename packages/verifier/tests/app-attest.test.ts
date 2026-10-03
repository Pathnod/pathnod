import assert from "node:assert/strict";
import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { decodeCbor } from "../src/app-attest-cbor.ts";
import { AppAttestGate } from "../src/app-attest-gate.ts";
import { AppAttestVerifier, AppAttestVerificationError } from "../src/app-attest.ts";

const appID = "U5MCCC24G5.xyz.pathnod.appattestspike";
const developmentPolicy = { appID, environment: "development", allowedValidationCategories: [3] } as const;

function rejectsCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AppAttestVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("strict App Attest inputs", () => {
  it("pins the Apple App Attestation root certificate", () => {
    const root = new X509Certificate(readFileSync(new URL("../Apple_App_Attestation_Root_CA.crt", import.meta.url)));
    assert.equal(root.fingerprint256, "1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32");
  });

  it("rejects duplicate CBOR keys, trailing bytes, and indefinite lengths", () => {
    assert.equal((decodeCbor(Buffer.from([0xa1, 0x61, 0x78, 0x01])) as Map<string, number>).get("x"), 1);
    assert.throws(() => decodeCbor(Buffer.from([0xa2, 0x61, 0x78, 0x01, 0x61, 0x78, 0x02])));
    assert.throws(() => decodeCbor(Buffer.from([0xa1, 0x61, 0x78, 0x01, 0x00])));
    assert.throws(() => decodeCbor(Buffer.from([0x9f, 0xff])));
  });

  it("rejects missing or ambiguous app policy", () => {
    rejectsCode("invalid_input", () => new AppAttestVerifier({ appID: "xyz.pathnod.appattestspike", environment: "development", allowedValidationCategories: [3] }));
    rejectsCode("invalid_input", () => new AppAttestVerifier({ appID, environment: "development", allowedValidationCategories: [] }));
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      rejectsCode("invalid_input", () => new AppAttestVerifier(developmentPolicy));
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("persists one-time challenges and consumes a failed attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "pathnod-app-attest-test-"));
    const path = join(directory, "gate.sqlite");
    try {
      let gate = new AppAttestGate(path, developmentPolicy);
      const trial = gate.issueTrial();
      assert.equal(trial.attestation.bytes.length, 32);
      assert.notDeepEqual(trial.firstAssertion.bytes, trial.secondAssertion.bytes);
      gate.close();

      gate = new AppAttestGate(path, developmentPolicy);
      rejectsCode("invalid_attestation", () => gate.acceptAttestation(trial.attestation.id, randomBytes(32).toString("base64"), Buffer.from([0xa0])));
      rejectsCode("invalid_input", () => gate.acceptAttestation(trial.attestation.id, randomBytes(32).toString("base64"), Buffer.from([0xa0])));
      gate.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface LocalEvidence {
  keyID: string;
  attestationChallenge: string;
  firstAssertionChallenge: string;
  secondAssertionChallenge: string;
  attestation: string;
  firstAssertion: string;
  secondAssertion: string;
}

const localEvidencePath = process.env.PATHNOD_DEV19_EVIDENCE;
const hasLocalEvidence = localEvidencePath !== undefined && existsSync(localEvidencePath);

it("validates real iPhone evidence and rejects altered trust inputs", { skip: !hasLocalEvidence }, () => {
  const evidence = JSON.parse(readFileSync(localEvidencePath!, "utf8")) as LocalEvidence;
  const bytes = (value: string): Buffer => Buffer.from(value, "base64");
  const attestation = bytes(evidence.attestation);
  const challenge = bytes(evidence.attestationChallenge);
  const firstAssertion = bytes(evidence.firstAssertion);
  const firstChallenge = bytes(evidence.firstAssertionChallenge);
  const secondAssertion = bytes(evidence.secondAssertion);
  const secondChallenge = bytes(evidence.secondAssertionChallenge);
  const verifier = new AppAttestVerifier(developmentPolicy);

  const enrolled = verifier.verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge });
  assert.equal(enrolled.counter, 0);
  assert.equal(enrolled.validationCategory, 3);
  const afterFirst = verifier.verifyAssertion({ key: enrolled, object: firstAssertion, expectedChallenge: firstChallenge });
  assert.equal(afterFirst.counter, 1);
  const afterSecond = verifier.verifyAssertion({ key: afterFirst, object: secondAssertion, expectedChallenge: secondChallenge });
  assert.equal(afterSecond.counter, 2);

  rejectsCode("invalid_nonce", () => verifier.verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: randomBytes(32) }));
  rejectsCode("invalid_key", () => verifier.verifyAttestation({ keyID: Buffer.alloc(32).toString("base64"), object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_app", () => new AppAttestVerifier({ ...developmentPolicy, appID: "U5MCCC24G5.xyz.pathnod.wrong" }).verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => new AppAttestVerifier({ ...developmentPolicy, environment: "production" }).verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_environment", () => new AppAttestVerifier({ ...developmentPolicy, allowedValidationCategories: [4] }).verifyAttestation({ keyID: evidence.keyID, object: attestation, expectedChallenge: challenge }));
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({ key: enrolled, object: firstAssertion, expectedChallenge: randomBytes(32) }));
  rejectsCode("invalid_counter", () => verifier.verifyAssertion({ key: afterFirst, object: firstAssertion, expectedChallenge: firstChallenge }));

  const decoded = decodeCbor(attestation) as Map<string, Map<string, Buffer[]>>;
  const leaf = decoded.get("attStmt")!.get("x5c")![0]!;
  const changedCertificate = Buffer.from(attestation);
  const leafOffset = changedCertificate.indexOf(leaf);
  assert.ok(leafOffset >= 0);
  changedCertificate[leafOffset + leaf.length - 1]! ^= 1;
  rejectsCode("invalid_chain", () => verifier.verifyAttestation({ keyID: evidence.keyID, object: changedCertificate, expectedChallenge: challenge }));

  const assertionMap = decodeCbor(firstAssertion) as Map<string, Buffer>;
  const signature = assertionMap.get("signature")!;
  const changedSignature = Buffer.from(firstAssertion);
  const signatureOffset = changedSignature.indexOf(signature);
  assert.ok(signatureOffset >= 0);
  changedSignature[signatureOffset + signature.length - 1]! ^= 1;
  rejectsCode("invalid_assertion", () => verifier.verifyAssertion({ key: enrolled, object: changedSignature, expectedChallenge: firstChallenge }));
});
