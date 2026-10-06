import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevelopmentObservationInbox, parseObservationEnvelope, type ObservationEnvelope } from "../src/observation-inbox.ts";
import { createEnrollmentServer } from "../src/enrollment-http.ts";
import { ObserverEnrollmentService } from "../src/observer-enrollment.ts";
import { FakeEnrollmentGate } from "./helpers/enrollment-gate.ts";

const vector = (JSON.parse(readFileSync(new URL("../../../fixtures/observations/transcript-v0.json", import.meta.url), "utf8")) as {
  vectors: { bytes: string; hash: string; protocolField: string; deviceField: string; enrollment: { root: string };
    transcript: { epoch: number; nullifier: string; pseudonym: string; observerClass: number } }[];
}).vectors[0]!;
function envelope(): ObservationEnvelope {
  // Deliberately fake proof and assertion: reception must never be labelled verification.
  return { transcript: Buffer.from(vector.bytes.slice(2), "hex").toString("base64"), assertion: "Kg==", key_id: "test-only",
    zk: { proof: { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"],
      protocol: "groth16", curve: "bn128" }, public: [BigInt(vector.enrollment.root).toString(), BigInt(vector.protocolField).toString(),
      BigInt(vector.deviceField).toString(), String(vector.transcript.epoch), BigInt(vector.transcript.nullifier).toString(),
      BigInt(vector.transcript.pseudonym).toString(), String(vector.transcript.observerClass)] } };
}
test("development receipt is persistent, idempotent, bounded and never policy-approved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-dev32-")), db = join(dir, "receipt.sqlite");
  let inbox = new DevelopmentObservationInbox(db, 1);
  try {
    const e = envelope(), receipt = await inbox.receive(e);
    assert.deepEqual(receipt, { status: "received", transcript_hash: vector.hash.slice(2), policy_validated: false });
    inbox.close(); inbox = new DevelopmentObservationInbox(db, 1);
    assert.deepEqual(await inbox.receive(e), receipt);
    await assert.rejects(inbox.receive({ ...e, assertion: "Kw==" }), /receipt_conflict/);
    const t = Buffer.from(e.transcript, "base64"); t[102] = t[102]! ^ 1;
    await assert.rejects(inbox.receive({ ...e, transcript: t.toString("base64") }), /inbox_full/);
    const disk = readFileSync(db);
    assert.ok(!disk.includes(Buffer.from("test-only"))); assert.ok(!disk.includes(Buffer.from(e.transcript)));
  } finally { inbox.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("envelope parser rejects malformed framing, extra fields and mismatched public inputs", async () => {
  const e = envelope(); await parseObservationEnvelope(e);
  for (const invalid of [
    { ...e, s_obs: "secret" }, { ...e, assertion: "" }, { ...e, transcript: e.transcript + "\n" },
    { ...e, key_id: "" }, { ...e, evidence: "" }, { ...e, zk: { ...e.zk, public: e.zk.public.slice(1) } },
    { ...e, zk: { ...e.zk, public: e.zk.public.map((v, i) => i === 1 ? "0" : v) } },
    { ...e, zk: { ...e.zk, public: ["21888242871839275222246405745257275088548364400416034343698204186575808495617", ...e.zk.public.slice(1)] } },
    { ...e, zk: { ...e.zk, proof: { ...e.zk.proof, pi_b: [] } } },
  ]) await assert.rejects(parseObservationEnvelope(invalid), /invalid_observation/);
});
test("POST /observations is unavailable by default; explicit local sink returns a bound 202 receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-dev32-http-"));
  const service = await ObserverEnrollmentService.open(join(dir, "enrollment.sqlite"), new FakeEnrollmentGate());
  const inbox = new DevelopmentObservationInbox(join(dir, "receipts.sqlite"));
  const servers = [createEnrollmentServer(service), createEnrollmentServer(service, undefined, undefined, inbox)];
  try {
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i]!;
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}/observations`;
      const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const response = await post(envelope()); assert.equal(response.status, i === 0 ? 503 : 202);
      if (i === 1) {
        assert.deepEqual(await response.json(), { status: "received", transcript_hash: vector.hash.slice(2), policy_validated: false });
        assert.equal((await post(envelope())).status, 202);
        assert.equal((await post({ ...envelope(), privateKey: "never send" })).status, 400);
        assert.equal((await fetch(url)).status, 405);
      }
    }
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    inbox.close(); service.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Swift envelope plus actual Mopro proof reaches the HTTP receiver", {
  skip: !process.env.PATHNOD_DEV32_SWIFT_ENVELOPE || !process.env.PATHNOD_DEV32_MOPRO_PROOF,
}, async () => {
  const swift = JSON.parse(readFileSync(process.env.PATHNOD_DEV32_SWIFT_ENVELOPE!, "utf8")) as ObservationEnvelope;
  const zk = JSON.parse(readFileSync(process.env.PATHNOD_DEV32_MOPRO_PROOF!, "utf8")) as ObservationEnvelope["zk"];
  assert.deepEqual(zk.public, swift.zk.public);
  const input = { ...swift, zk };
  const dir = mkdtempSync(join(tmpdir(), "pathnod-dev32-e2e-"));
  const service = await ObserverEnrollmentService.open(join(dir, "enrollment.sqlite"), new FakeEnrollmentGate());
  const inbox = new DevelopmentObservationInbox(join(dir, "receipts.sqlite"));
  const server = createEnrollmentServer(service, undefined, undefined, inbox);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/observations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "received", transcript_hash: vector.hash.slice(2), policy_validated: false });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    inbox.close(); service.close(); rmSync(dir, { recursive: true, force: true });
  }
});
