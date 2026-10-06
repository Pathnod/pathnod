import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildPoseidon } from "circomlibjs";

import { createEnrollmentServer } from "../src/enrollment-http.ts";
import { EnrollmentError, ObserverEnrollmentService, type MerklePath } from "../src/observer-enrollment.ts";

import { FakeEnrollmentGate as FakeGate } from "./helpers/enrollment-gate.ts";

const commitmentA = `0x${"01".padStart(64, "0")}`;
const commitmentB = `0x${"02".padStart(64, "0")}`;
const observerVectorCommitment = "0x2619cd97089689221d77e4e4c3353a4e2488fc2075f74e70bfc7c68a9e077f78";
const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");

async function verify(path: MerklePath): Promise<void> {
  const poseidon = await buildPoseidon();
  const hash = (...inputs: bigint[]) => poseidon.F.toObject(poseidon(inputs));
  assert.equal(path.siblings.length, 20);
  assert.equal(path.directions.length, 20);
  assert.equal(path.leaf, `0x${hash(BigInt(path.commitment), BigInt(path.observerClass)).toString(16).padStart(64, "0")}`);
  let current = BigInt(path.leaf);
  for (let level = 0; level < 20; level++) {
    const sibling = BigInt(path.siblings[level]!);
    assert.equal(path.directions[level], (path.leafIndex >> level) & 1);
    current = path.directions[level] === 0 ? hash(current, sibling) : hash(sibling, current);
  }
  assert.equal(path.root, `0x${current.toString(16).padStart(64, "0")}`);
}

test("enrollment, append, replay guard, re-enrollment and persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-enroll-"));
  const db = join(dir, "enrollment.sqlite");
  const gate = new FakeGate();
  let service = await ObserverEnrollmentService.open(db, gate);
  try {
    const first = service.issueEnrollmentChallenge(commitmentA, keyA);
    assert.equal(first.mode, "attestation");
    assert.throws(() => service.enroll(first.id, commitmentB, keyA, Buffer.from([42])), (error) => error instanceof EnrollmentError && error.code === "invalid_challenge");
    assert.throws(() => service.enroll(first.id, commitmentA, keyA, Buffer.from([42])), (error) => error instanceof EnrollmentError && error.code === "invalid_challenge");
    assert.equal(service.root().revision, 0);
    assert.throws(() => service.issueEnrollmentChallenge("0x1", keyA), (error) => error instanceof EnrollmentError && error.code === "invalid_input");
    assert.throws(() => service.issueTreeChallenge(commitmentA, keyA), (error) => error instanceof EnrollmentError && error.code === "unknown_observer");

    const expired = service.issueEnrollmentChallenge(commitmentA, keyA);
    const connection = new DatabaseSync(db);
    connection.prepare("UPDATE observer_challenges SET expires_at = 0 WHERE id = ?").run(expired.id);
    connection.close();
    assert.throws(() => service.enroll(expired.id, commitmentA, keyA, Buffer.from([42])), (error) => error instanceof EnrollmentError && error.code === "invalid_challenge");

    const invalid = service.issueEnrollmentChallenge(commitmentA, keyA);
    assert.throws(() => service.enroll(invalid.id, commitmentA, keyA, Buffer.from([0])), (error) => error instanceof EnrollmentError && error.code === "invalid_attestation");
    assert.equal(service.root().revision, 0);

    const a = service.issueEnrollmentChallenge(commitmentA, keyA);
    const pathA = service.enroll(a.id, commitmentA, keyA, Buffer.from([42]));
    assert.equal(pathA.leafIndex, 0);
    assert.equal(pathA.observerClass, 1);
    assert.equal(pathA.rootRevision, 1);
    await verify(pathA);

    const b = service.issueEnrollmentChallenge(commitmentB, keyB);
    const pathB = service.enroll(b.id, commitmentB, keyB, Buffer.from([42]));
    assert.equal(pathB.leafIndex, 1);
    assert.equal(pathB.rootRevision, 2);
    await verify(pathB);
    assert.notEqual(pathB.root, pathA.root);
    assert.throws(() => service.issueEnrollmentChallenge(commitmentB, keyA), (error) => error instanceof EnrollmentError && error.code === "already_enrolled");
    assert.throws(() => service.issueEnrollmentChallenge(commitmentA, keyB), (error) => error instanceof EnrollmentError && error.code === "already_enrolled");

    const again = service.issueEnrollmentChallenge(commitmentA, keyA);
    assert.equal(again.mode, "assertion");
    const reenrolled = service.enroll(again.id, commitmentA, keyA, Buffer.from([42]));
    assert.equal(reenrolled.rootRevision, 2);
    assert.equal(reenrolled.leafIndex, 0);
    await verify(reenrolled);
    const journal = new DatabaseSync(db);
    const events = journal.prepare("SELECT action, root_revision FROM observer_enrollment_events ORDER BY sequence").all();
    assert.deepEqual(events.map((row) => [row.action, row.root_revision]), [
      ["enrolled", 1], ["enrolled", 2], ["reenrolled", 2],
    ]);
    journal.close();

    const tree = service.issueTreeChallenge(commitmentA, keyA);
    const refreshed = service.treePath(tree.id, commitmentA, keyA, Buffer.from([42]));
    assert.equal(refreshed.root, pathB.root);
    await verify(refreshed);
    assert.throws(() => service.treePath(tree.id, commitmentA, keyA, Buffer.from([42])), (error) => error instanceof EnrollmentError && error.code === "invalid_challenge");

    service.close();
    service = await ObserverEnrollmentService.open(db, gate);
    assert.equal(service.root().root, pathB.root);
    assert.equal(service.root().revision, 2);
    const persisted = service.issueTreeChallenge(commitmentB, keyB);
    await verify(service.treePath(persisted.id, commitmentB, keyB, Buffer.from([42])));
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("enrollment uses the pinned commitment vector and Poseidon leaf contract", async () => {
  const poseidon = await buildPoseidon();
  assert.equal(
    `0x${poseidon.F.toObject(poseidon([1234567890123456789012345678901234567890n])).toString(16).padStart(64, "0")}`,
    observerVectorCommitment,
  );
  const dir = mkdtempSync(join(tmpdir(), "pathnod-enroll-vector-"));
  const service = await ObserverEnrollmentService.open(join(dir, "enrollment.sqlite"), new FakeGate());
  try {
    const issued = service.issueEnrollmentChallenge(observerVectorCommitment, keyA);
    const path = service.enroll(issued.id, observerVectorCommitment, keyA, Buffer.from([42]));
    assert.equal(path.observerClass, 1);
    await verify(path);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP rejects invalid evidence and returns a valid path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-enroll-http-"));
  const gate = new FakeGate();
  const service = await ObserverEnrollmentService.open(join(dir, "enrollment.sqlite"), gate);
  const server = createEnrollmentServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, value: unknown) => fetch(base + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    });
    assert.equal((await post("/enroll/challenge", { commitment: commitmentA, keyID: keyA, observerClass: 7 })).status, 400);
    assert.equal((await post("/enroll/challenge", { commitment: commitmentA, keyID: keyA, s_obs: "must-not-be-submitted" })).status, 400);
    const challengeResponse = await post("/enroll/challenge", { commitment: commitmentA, keyID: keyA });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { id: string; mode: string };
    assert.equal(challenge.mode, "attestation");
    const enrollResponse = await post("/enroll", { challengeID: challenge.id, commitment: commitmentA, keyID: keyA, object: Buffer.from([42]).toString("base64") });
    assert.equal(enrollResponse.status, 200);
    await verify(await enrollResponse.json() as MerklePath);
    assert.equal((await post("/enroll", { challengeID: challenge.id, commitment: commitmentA, keyID: keyA, object: "Kg==" })).status, 400);
    const treeChallenge = await (await post("/tree/challenge", { commitment: commitmentA, keyID: keyA }))
      .json() as { id: string };
    const pathURL = `${base}/tree?commitment=${encodeURIComponent(commitmentA)}`;
    const headers = {
      "x-pathnod-challenge-id": treeChallenge.id,
      "x-pathnod-key-id": keyA,
      "x-pathnod-assertion": "Kg==",
    };
    const treeResponse = await fetch(pathURL, { headers });
    assert.equal(treeResponse.status, 200);
    await verify(await treeResponse.json() as MerklePath);
    assert.equal((await fetch(pathURL, { headers })).status, 400);
    assert.equal((await post("/tree/challenge", { commitment: commitmentB, keyID: keyB })).status, 404);
    assert.equal((await fetch(base + "/root")).status, 200);
    const disabled = await fetch(`${base}/devices/${commitmentA}/slots?epoch=42`);
    assert.equal(disabled.status, 503);
    assert.deepEqual(await disabled.json(), { error: "eligibility_unavailable" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close(); rmSync(dir, { recursive: true, force: true });
  }
});
