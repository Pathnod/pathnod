import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AppAttestGate } from "../src/app-attest-gate.ts";
import { ObserverEnrollmentService } from "../src/observer-enrollment.ts";
import { EnrollmentError } from "../src/observer-enrollment.ts";
import { AppAttestVerificationError } from "../src/app-attest.ts";
import { createEnrollmentServer } from "../src/enrollment-http.ts";

const policy = { appID: "U5MCCC24G5.xyz.pathnod.appattestspike", environment: "development",
  allowedValidationCategories: [3], allowedBundleVersions: [] } as const;

test("new issuance purges expired records in both persisted challenge tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-expired-")), filename = join(dir, "enrollment.sqlite");
  const gate = new AppAttestGate(filename, policy);
  const service = await ObserverEnrollmentService.open(filename, gate);
  const db = new DatabaseSync(filename);
  try {
    for (let i = 0; i < 100; i++) service.issueEnrollmentChallenge(`0x${"01".padStart(64, "0")}`, randomBytes(32).toString("base64"));
    db.exec("UPDATE observer_challenges SET expires_at=0; UPDATE app_attest_challenges SET expires_at=0");
    service.issueEnrollmentChallenge(`0x${"02".padStart(64, "0")}`, randomBytes(32).toString("base64"));
    for (const table of ["observer_challenges", "app_attest_challenges"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1);
    }
  } finally { db.close(); service.close(); gate.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pending limits bound both tables and expiry frees capacity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-cap-")), filename = join(dir, "enrollment.sqlite");
  const gate = new AppAttestGate(filename, policy, { maxPendingChallenges: 4 });
  const service = await ObserverEnrollmentService.open(filename, gate, { maxPendingChallenges: 4 });
  const db = new DatabaseSync(filename);
  const issue = () => service.issueEnrollmentChallenge(`0x${"01".padStart(64, "0")}`, randomBytes(32).toString("base64"));
  try {
    const first = issue(); issue(); issue(); issue();
    for (let i = 0; i < 20; i++) assert.throws(issue, error => error instanceof EnrollmentError && error.code === "challenge_limit");
    for (const table of ["observer_challenges", "app_attest_challenges"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 4);
      db.prepare(`UPDATE ${table} SET expires_at=0 WHERE id=?`).run(first.id);
    }
    issue();
    for (const table of ["observer_challenges", "app_attest_challenges"]) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 4);
  } finally { db.close(); service.close(); gate.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("trial reservations are atomic and a failed enrollment insert leaves no gate orphan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-trial-cap-")), filename = join(dir, "enrollment.sqlite");
  const gate = new AppAttestGate(filename, policy, { maxPendingChallenges: 4 });
  const service = await ObserverEnrollmentService.open(filename, gate);
  const db = new DatabaseSync(filename);
  try {
    gate.issueTrial();
    assert.throws(() => gate.issueTrial(), error => error instanceof AppAttestVerificationError && error.code === "challenge_limit");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM app_attest_challenges").get() as { n: number }).n, 3);
    db.exec("CREATE TRIGGER fail_issue BEFORE INSERT ON observer_challenges BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => service.issueEnrollmentChallenge(`0x${"01".padStart(64, "0")}`, randomBytes(32).toString("base64")));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM app_attest_challenges").get() as { n: number }).n, 3);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM observer_challenges").get() as { n: number }).n, 0);
  } finally { db.close(); service.close(); gate.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP rejects repeated issuance with 429 without adding either record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-http-cap-")), filename = join(dir, "enrollment.sqlite");
  const gate = new AppAttestGate(filename, policy, { maxPendingChallenges: 1 });
  const service = await ObserverEnrollmentService.open(filename, gate, { maxPendingChallenges: 1 });
  const server = createEnrollmentServer(service), db = new DatabaseSync(filename);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const issue = () => fetch(`http://127.0.0.1:${address.port}/enroll/challenge`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitment: `0x${"01".padStart(64, "0")}`, keyID: randomBytes(32).toString("base64") }),
    });
    assert.equal((await issue()).status, 200);
    const response = await issue(); assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "challenge_limit" });
    for (const table of ["observer_challenges", "app_attest_challenges"]) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); service.close(); gate.close(); rmSync(dir, { recursive: true, force: true });
  }
});
