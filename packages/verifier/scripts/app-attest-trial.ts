import { readFileSync, writeFileSync } from "node:fs";

import { AppAttestGate } from "../src/app-attest-gate.ts";
import type { AppAttestPolicy } from "../src/app-attest.ts";

interface TrialFile {
  session: string;
  attestationChallenge: string;
  firstAssertionChallenge: string;
  secondAssertionChallenge: string;
  attestationChallengeID: string;
  firstAssertionChallengeID: string;
  secondAssertionChallengeID: string;
}

interface EvidenceFile {
  session: string;
  keyID: string;
  attestationChallenge: string;
  firstAssertionChallenge: string;
  secondAssertionChallenge: string;
  attestation: string;
  firstAssertion: string;
  secondAssertion: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function strictBase64(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid evidence encoding.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length === 0) throw new Error("Invalid evidence encoding.");
  return bytes;
}

const [command, databasePath, requestPath, fourth, fifth] = process.argv.slice(2);
if (!databasePath || !requestPath || !fourth || (command !== "issue" && command !== "verify")) {
  throw new Error("Usage: app-attest-trial.ts issue <db> <request.json> <app-id> | verify <db> <request.json> <evidence.json> <app-id>");
}
const appID = command === "issue" ? fourth : fifth;
if (!appID) throw new Error("Missing App ID.");
const policy: AppAttestPolicy = {
  appID,
  environment: "development",
  allowedValidationCategories: [3],
};

if (command === "issue") {
  const gate = new AppAttestGate(databasePath, policy);
  try {
    const trial = gate.issueTrial();
    const request: TrialFile = {
      session: trial.session,
      attestationChallenge: trial.attestation.bytes.toString("base64"),
      firstAssertionChallenge: trial.firstAssertion.bytes.toString("base64"),
      secondAssertionChallenge: trial.secondAssertion.bytes.toString("base64"),
      attestationChallengeID: trial.attestation.id,
      firstAssertionChallengeID: trial.firstAssertion.id,
      secondAssertionChallengeID: trial.secondAssertion.id,
    };
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600, flag: "wx" });
    console.log("Issued three one-time challenges for a device trial.");
  } finally {
    gate.close();
  }
} else {
  const request = readJson<TrialFile>(requestPath);
  const evidence = readJson<EvidenceFile>(fourth);
  if (
    request.session !== evidence.session ||
    request.attestationChallenge !== evidence.attestationChallenge ||
    request.firstAssertionChallenge !== evidence.firstAssertionChallenge ||
    request.secondAssertionChallenge !== evidence.secondAssertionChallenge
  ) {
    throw new Error("Evidence session does not match the issued trial.");
  }
  let gate = new AppAttestGate(databasePath, policy);
  try {
    gate.acceptAttestation(request.attestationChallengeID, evidence.keyID, strictBase64(evidence.attestation));
  } finally {
    gate.close();
  }
  gate = new AppAttestGate(databasePath, policy);
  try {
    gate.acceptAssertion(request.firstAssertionChallengeID, evidence.keyID, strictBase64(evidence.firstAssertion));
  } finally {
    gate.close();
  }
  gate = new AppAttestGate(databasePath, policy);
  try {
    const key = gate.acceptAssertion(request.secondAssertionChallengeID, evidence.keyID, strictBase64(evidence.secondAssertion));
    if (key.counter !== 2) throw new Error("Unexpected final assertion counter.");
    console.log("Device attestation and two assertions accepted; final counter: 2.");
  } finally {
    gate.close();
  }
}
