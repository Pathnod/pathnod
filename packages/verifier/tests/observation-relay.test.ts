import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authorizationDigest, authorizationPreimage, authorizationInstruction, ObservationSigner,
  verifyAuthorization, relayProofBytes } from "../src/observation-authorization.ts";
import { initializeObservationRelay, queueValidatedObservation, ObservationRelayer,
  type ObservationRelayPayload, type PreparedObservationTransaction, type ObservationRelayTransport } from "../src/observation-relay.ts";

const vector = JSON.parse(readFileSync(new URL("../../../fixtures/observations/verifier-authorization-v0.json", import.meta.url), "utf8"));
test("DEV-34: shared signing preimage/digest/signature, domain and each signed field", () => {
  const signer = new ObservationSigner(Buffer.alloc(32, 7));
  assert.equal(signer.publicKey, vector.verifier); assert.equal(signer.sign(vector), vector.signature);
  assert.equal(authorizationPreimage(vector).toString("hex"), vector.preimage);
  assert.equal(authorizationDigest(vector).toString("hex"), vector.digest);
  assert.ok(verifyAuthorization(vector, vector.verifier, vector.signature));
  for (const change of [{ transcriptHash: "22".repeat(32) }, { nullifier: "00".repeat(31) + "23" },
    { pseudonym: "00".repeat(31) + "34" }, { observerClass: 2 }, { policyVersion: vector.policyVersion + 1 }]) {
    assert.ok(!verifyAuthorization({ ...vector, ...change }, vector.verifier, vector.signature));
  }
  assert.ok(!verifyAuthorization(vector, new ObservationSigner(Buffer.alloc(32, 8)).publicKey, vector.signature));
  for (const change of [{ observerClass: 0 }, { policyVersion: 0 }, { policyVersion: 2 ** 32 },
    { nullifier: "ff".repeat(32) }, { transcriptHash: "AA".repeat(32) }]) assert.throws(() => authorizationDigest({ ...vector, ...change }));
  const ix = authorizationInstruction(vector, vector.verifier, vector.signature);
  assert.equal(ix.data[0], 1);
  assert.equal(ix.data.readUInt16LE(12), 32);
  assert.equal(ix.data.readUInt16LE(14), 0xffff);
  assert.equal(ix.data.subarray(-32).toString("hex"), vector.digest);
});
test("DEV-34: proof conversion negates A once, swaps G2 limbs and preserves seven canonical inputs", () => {
  const proof = { protocol: "groth16", curve: "bn128", pi_a: ["1", "2", "1"],
    pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const bytes = relayProofBytes(proof, ["1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(bytes.length, 480);
  assert.equal(BigInt("0x" + bytes.subarray(32, 64).toString("hex")),
    21888242871839275222246405745257275088696311157297823662689037894645226208581n);
  assert.deepEqual([95, 127, 159, 191].map(i => bytes[i]), [4, 3, 6, 5]);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => bytes[256 + i * 32 + 31]), [1, 2, 3, 4, 5, 6, 7]);
  assert.throws(() => relayProofBytes(proof, ["01", "2", "3", "4", "5", "6", "7"]));
});
class Transport implements ObservationRelayTransport {
  target = "synthetic-genesis/program/protocol/key/payer/dev35-contract";
  state: "missing" | "pending" | "confirmed" | "failed" = "missing";
  allowed = true; isExpired = false; ambiguous = false; prepareCalls = 0; sent: string[] = [];
  inspectFailure = false;
  inspectStates: Array<"missing" | "pending" | "confirmed" | "failed"> = [];
  async eligible() { return this.allowed; }
  async prepare(): Promise<PreparedObservationTransaction> {
    this.prepareCalls++;
    return { wire: `synthetic-wire-${this.prepareCalls}`, signature: `synthetic-signature-${this.prepareCalls}`, lastValidBlockHeight: 100 };
  }
  async send(tx: PreparedObservationTransaction) {
    this.sent.push(tx.wire);
    if (this.ambiguous) { this.state = "confirmed"; throw Error("Lost reply after execution"); }
  }
  async inspect() { if (this.inspectFailure) throw Error("RPC timeout"); return this.inspectStates.shift() ?? this.state; }
  async expired() { return this.isExpired; }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-dev34-")), path = join(dir, "relay.sqlite");
  const db = new DatabaseSync(path), transport = new Transport();
  initializeObservationRelay(db, "test-only-policy", vector.verifier);
  // Synthetic validated ledger for worker tests only; real handoff has policy integration tests.
  db.exec("CREATE TABLE observation_validations_v0 (transcript_hash TEXT PRIMARY KEY, nullifier TEXT NOT NULL)");
  db.prepare("INSERT INTO observation_validations_v0 VALUES (?, ?)").run(vector.transcriptHash, vector.nullifier);
  const payload: ObservationRelayPayload = { transcriptHash: vector.transcriptHash, nullifier: vector.nullifier,
    pseudonym: vector.pseudonym, observerClass: vector.observerClass, policyVersion: vector.policyVersion,
    protocolID: "11".repeat(32), deviceID: "22".repeat(32), evidenceHash: "00".repeat(32), epoch: 1,
    proofBytes: relayProofBytes({ protocol: "groth16", curve: "bn128", pi_a: ["1", "2", "1"],
      pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] },
      ["1", "2", "3", "1", "34", "51", "1"]).toString("hex"), verifier: vector.verifier, verifierSignature: vector.signature };
  db.exec("BEGIN IMMEDIATE"); queueValidatedObservation(db, payload, 100); db.exec("COMMIT");
  let now = 1000;
  const open = () => new ObservationRelayer(path, "test-only-policy", vector.verifier, transport, () => now);
  return { dir, path, db, transport, payload, open, advance: () => { now += 5000; },
    close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("DEV-34: lost response is reconciled after restart, not resent; confirmation is distinct from broadcast", async () => {
  const f = fixture(); let worker = f.open(); f.transport.ambiguous = true;
  try {
    await Promise.all([worker.tick(), worker.tick()]);
    assert.equal(f.transport.prepareCalls, 1); assert.equal(f.transport.sent.length, 1);
    assert.equal(worker.status(vector.transcriptHash)?.status, "submitted");
    assert.equal(worker.status(vector.transcriptHash)?.on_chain, false);
    assert.throws(f.open, /already owns/);
    await worker.close(); worker = f.open(); f.advance(); await worker.tick();
    assert.equal(worker.status(vector.transcriptHash)?.status, "confirmed");
    assert.equal(worker.status(vector.transcriptHash)?.paid, false);
    assert.equal(f.transport.sent.length, 1);
  } finally { await worker.close(); f.close(); }
});
test("DEV-34: identical signed bytes survive retries; replacement requires observed expiry and missing history", async () => {
  const f = fixture(), worker = f.open();
  try {
    await worker.tick(); f.advance(); await worker.tick();
    assert.equal(f.transport.prepareCalls, 1); assert.deepEqual(f.transport.sent, ["synthetic-wire-1", "synthetic-wire-1"]);
    f.transport.state = "pending"; f.transport.isExpired = true; f.advance(); await worker.tick();
    assert.equal(f.transport.prepareCalls, 1);
    f.transport.state = "missing"; f.advance(); await worker.tick();
    assert.equal(f.transport.prepareCalls, 2); assert.equal(f.transport.sent.at(-1), "synthetic-wire-2");
    f.transport.state = "failed"; f.advance(); await worker.tick(); f.advance(); await worker.tick();
    assert.equal(worker.status(vector.transcriptHash)?.status, "failed"); assert.equal(f.transport.sent.length, 3);
  } finally { await worker.close(); f.close(); }
});
test("DEV-34: changed policy/root stops broadcasts; altered authorization and target switches fail closed", async () => {
  const f = fixture(), worker = f.open();
  try {
    f.transport.allowed = false; await worker.tick();
    assert.equal(worker.status(vector.transcriptHash)?.status, "failed"); assert.equal(f.transport.sent.length, 0);
    assert.throws(() => new ObservationRelayer(f.path, "another-policy", vector.verifier, f.transport), /mismatch/);
    await worker.close(); f.transport.target = "another-cluster"; assert.throws(f.open, /mismatch/);
  } finally { await worker.close(); f.close(); }
});
test("DEV-34: changed eligibility cannot abandon an unexpired broadcast; restart reconciles without resend", async () => {
  const f = fixture(); let worker = f.open();
  try {
    await worker.tick();
    const original = f.db.prepare("SELECT wire, signature, last_valid_height FROM observation_relay_jobs").get();
    f.transport.allowed = false; f.advance(); await worker.tick();
    assert.equal(worker.status(vector.transcriptHash)?.status, "submitted");
    assert.equal(worker.status(vector.transcriptHash)?.on_chain, false);
    assert.deepEqual(f.db.prepare("SELECT wire, signature, last_valid_height FROM observation_relay_jobs").get(), original);
    assert.equal(f.transport.sent.length, 1); assert.equal(f.transport.prepareCalls, 1);
    await worker.close(); worker = f.open();
    f.transport.state = "confirmed"; f.advance(); await worker.tick();
    assert.equal(worker.status(vector.transcriptHash)?.status, "confirmed");
    assert.equal(worker.status(vector.transcriptHash)?.on_chain, true);
    assert.equal(f.transport.sent.length, 1); assert.equal(f.transport.prepareCalls, 1);
  } finally { await worker.close(); f.close(); }
});
test("DEV-34: changed eligibility becomes terminal only after expiry and the second missing-history check", async () => {
  const f = fixture(), worker = f.open();
  try {
    await worker.tick(); f.transport.allowed = false; f.transport.isExpired = true;
    f.transport.inspectStates = ["missing", "missing"]; f.advance(); await worker.tick();
    assert.equal(f.transport.inspectStates.length, 0);
    assert.equal(worker.status(vector.transcriptHash)?.status, "failed");
    assert.equal(worker.status(vector.transcriptHash)?.last_error, "policy_or_chain_changed");
    assert.equal(f.transport.sent.length, 1); assert.equal(f.transport.prepareCalls, 1);
  } finally { await worker.close(); f.close(); }
});
test("DEV-34: confirmation in the second expiry check wins over changed eligibility", async () => {
  const f = fixture(), worker = f.open();
  try {
    await worker.tick(); f.transport.allowed = false; f.transport.isExpired = true;
    f.transport.inspectStates = ["missing", "confirmed"]; f.advance(); await worker.tick();
    assert.equal(f.transport.inspectStates.length, 0);
    assert.equal(worker.status(vector.transcriptHash)?.status, "confirmed");
    assert.equal(worker.status(vector.transcriptHash)?.on_chain, true);
    assert.equal(f.transport.sent.length, 1); assert.equal(f.transport.prepareCalls, 1);
  } finally { await worker.close(); f.close(); }
});
test("DEV-34: reconciliation outages never rebuild or resend; corrupted signatures cannot broadcast", async () => {
  const f = fixture(), worker = f.open();
  try {
    await worker.tick(); f.transport.inspectFailure = true; f.transport.isExpired = true;
    f.advance(); await worker.tick();
    assert.equal(f.transport.prepareCalls, 1); assert.equal(f.transport.sent.length, 1);
    assert.equal(worker.status(vector.transcriptHash)?.last_error, "retryable_failure");
    f.transport.inspectFailure = false;
    f.db.prepare("UPDATE observation_relay_jobs SET payload=?").run(JSON.stringify({ ...f.payload, verifierSignature: "00".repeat(64) }));
    f.advance(); await worker.tick();
    assert.equal(worker.status(vector.transcriptHash)?.status, "failed"); assert.equal(f.transport.sent.length, 1);
  } finally { await worker.close(); f.close(); }
});

test('DEV-35: an externally finalized matching commitment resolves queued and failed-signature jobs',async()=>{
  for(const submitted of [false,true]) {
    const f=fixture();let now=1000;
    let exists=false;
    const transport:ObservationRelayTransport={target:f.transport.target,eligible:f.transport.eligible.bind(f.transport),
      prepare:f.transport.prepare.bind(f.transport),send:f.transport.send.bind(f.transport),inspect:f.transport.inspect.bind(f.transport),expired:f.transport.expired.bind(f.transport),
      confirmExisting:async()=>exists};
    const worker=new ObservationRelayer(f.path,'test-only-policy',vector.verifier,transport,()=>now);
    try {
      if(submitted){await worker.tick();f.transport.state='failed';}
      exists=true;now+=5000;await worker.tick();
      assert.equal(worker.status(vector.transcriptHash)?.status,'confirmed');assert.equal(worker.status(vector.transcriptHash)?.on_chain,true);
      assert.equal(worker.status(vector.transcriptHash)?.signature,null);
      assert.equal(f.transport.sent.length,submitted?1:0);
    }finally{await worker.close();f.close();}
  }
});
