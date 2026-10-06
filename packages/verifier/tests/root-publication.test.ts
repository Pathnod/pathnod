import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ObserverEnrollmentService, type ObserverRootSnapshot } from "../src/observer-enrollment.ts";
import { ObserverRootPublisher, RootPublicationError, type RootPublicationSource,
  type RootPublicationTransport, type PreparedRootTransaction } from "../src/root-publication.ts";
import { FakeEnrollmentGate } from "./helpers/enrollment-gate.ts";
import { Keypair, PublicKey } from "@solana/web3.js";
import { discriminator, UPGRADEABLE_LOADER } from "@pathnod/solana";
import { SolanaRootPublicationTransport } from "../src/solana-root-publication.ts";

class Source implements RootPublicationSource {
  rows: ObserverRootSnapshot[] = [];
  add(at = 0) {
    const revision = this.rows.length + 1;
    const row = { root: `0x${revision.toString(16).padStart(64, "0")}`, revision, leafCount: revision, createdAt: at };
    this.rows.push(row);
    return row;
  }
  publicationBatch(revision: number) {
    const pending = this.rows.filter(row => row.revision > revision);
    const snapshot = pending.at(-1);
    return snapshot ? { snapshot, oldestPendingAt: pending[0]!.createdAt } : undefined;
  }
}

class Transport implements RootPublicationTransport {
  target = "test-genesis/program/authority";
  program = "test-program";
  cluster = "local" as const;
  roots = new Map<string, { leafCount: number; active: boolean }>();
  wires: string[] = [];
  prepares = 0;
  accept = true;
  ambiguous = false;
  isExpired = false;
  pause: Promise<void> | undefined;
  mismatch = false;
  address(root: string) { return root; }
  async inspect(snapshot: ObserverRootSnapshot) {
    if (this.mismatch) throw new RootPublicationError("account_mismatch");
    const record = this.roots.get(snapshot.root);
    if (record && record.leafCount !== snapshot.leafCount) throw new RootPublicationError("account_mismatch");
    return record ? { slot: 123, active: record.active } : undefined;
  }
  async prepare(snapshot: ObserverRootSnapshot) {
    this.prepares++;
    return { wire: JSON.stringify({ ...snapshot, prepare: this.prepares }), lastValidBlockHeight: 100 };
  }
  async send(tx: PreparedRootTransaction) {
    this.wires.push(tx.wire);
    await this.pause;
    const snapshot = JSON.parse(tx.wire) as ObserverRootSnapshot;
    if (this.accept) this.roots.set(snapshot.root, { leafCount: snapshot.leafCount, active: true });
    if (this.ambiguous) throw Error("Lost RPC reply");
    return `test-signature-${snapshot.revision}`;
  }
  async expired() { return this.isExpired; }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-root-pub-"));
  return { dir, db: join(dir, "enrollment.sqlite"), source: new Source(), transport: new Transport() };
}

test("batch size and maximum delay use the first unpublished leaf, not the latest leaf", async () => {
  const f = fixture(); let now = 0;
  const worker = new ObserverRootPublisher(f.db, f.source, f.transport, { batchSize: 3, maxDelayMs: 100, now: () => now });
  try {
    f.source.add(0); await worker.tick(); assert.equal(f.transport.wires.length, 0);
    now = 90; f.source.add(90); await worker.tick(); assert.equal(f.transport.wires.length, 0);
    now = 100; await worker.tick(); assert.equal(f.transport.wires.length, 1);
    assert.equal(worker.status().confirmed?.revision, 2);
    await worker.tick(); assert.equal(f.transport.wires.length, 1);
    f.source.add(100); f.source.add(100); f.source.add(100);
    await worker.tick(); assert.equal(f.transport.wires.length, 2);
    assert.equal(worker.status().confirmed?.leafCount, 5);
  } finally { await worker.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("an accepted transaction with a lost response is reconciled across restart without sending twice", async () => {
  const f = fixture(); let now = 0;
  f.source.add(); f.transport.ambiguous = true;
  let worker = new ObserverRootPublisher(f.db, f.source, f.transport, { batchSize: 1, now: () => now });
  try {
    await worker.tick(); assert.equal(worker.status().state, "retrying");
    assert.equal(worker.status().confirmed, null);
    const db = new DatabaseSync(f.db);
    const row = db.prepare("SELECT wire, status FROM observer_root_publications").get();
    assert.equal(row?.status, "submitted"); assert.equal(row?.wire, f.transport.wires[0]); db.close();
    await worker.close(); now = 1001;
    worker = new ObserverRootPublisher(f.db, f.source, f.transport, { batchSize: 1, now: () => now });
    await worker.tick(); assert.equal(worker.status().state, "confirmed");
    assert.equal(worker.status().confirmed?.signature, null);
    assert.equal(f.transport.wires.length, 1); assert.equal(f.transport.prepares, 1);
  } finally { await worker.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("submitted bytes survive retries; a new transaction is signed only after blockhash expiry", async () => {
  const f = fixture(); let now = 0;
  f.source.add(); f.transport.accept = false;
  const worker = new ObserverRootPublisher(f.db, f.source, f.transport, { batchSize: 1, now: () => now });
  try {
    await worker.tick(); assert.equal(worker.status().confirmed, null);
    now = 2000; await worker.tick(); assert.equal(f.transport.prepares, 1);
    assert.equal(f.transport.wires[0], f.transport.wires[1]);
    now = 4000; f.transport.isExpired = true; f.transport.accept = true;
    await worker.tick(); assert.equal(f.transport.prepares, 2);
    assert.notEqual(f.transport.wires[1], f.transport.wires[2]);
    assert.equal(worker.status().confirmed?.active, true);
  } finally { await worker.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("concurrent ticks share one publication; enrollments arriving during it form the next batch", async () => {
  const f = fixture(); f.source.add();
  let release!: () => void;
  f.transport.pause = new Promise<void>(resolve => { release = resolve; });
  const worker = new ObserverRootPublisher(f.db, f.source, f.transport, { batchSize: 1 });
  try {
    const first = worker.tick(); assert.equal(worker.tick(), first);
    await new Promise(resolve => setImmediate(resolve));
    f.source.add(); release(); await first;
    assert.equal(f.transport.wires.length, 1); assert.equal(worker.status().confirmed?.revision, 1);
    assert.equal(worker.status().state, "pending");
    await worker.tick(); assert.equal(f.transport.wires.length, 2);
    assert.equal(worker.status().confirmed?.revision, 2);
  } finally { await worker.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("mismatched accounts never confirm; historical roots are reported inactive without republication", async () => {
  const f = fixture(); const snapshot = f.source.add(); let now = 0;
  f.transport.mismatch = true;
  const worker = new ObserverRootPublisher(f.db, f.source, f.transport, { batchSize: 1, now: () => now });
  try {
    await worker.tick(); assert.equal(worker.status().lastError, "account_mismatch");
    assert.equal(worker.status().confirmed, null); assert.equal(f.transport.wires.length, 0);
    f.transport.mismatch = false; now = 1000;
    f.transport.roots.set(snapshot.root, { leafCount: 1, active: false });
    await worker.tick(); assert.equal(worker.status().state, "inactive");
    assert.equal(worker.status().confirmed?.active, false); assert.equal(f.transport.wires.length, 0);
    f.source.add(); await worker.tick(); assert.equal(worker.status().state, "confirmed");
    now = 31_000; f.transport.roots.get(f.source.rows[1]!.root)!.active = false;
    await worker.tick(); assert.equal(worker.status().state, "inactive");
  } finally { await worker.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("a database cannot silently switch cluster, program or enrollment authority", async () => {
  const f = fixture(); const worker = new ObserverRootPublisher(f.db, f.source, f.transport);
  await worker.close(); f.transport.target = "another-genesis/program/authority";
  try {
    assert.throws(() => new ObserverRootPublisher(f.db, f.source, f.transport),
      error => error instanceof RootPublicationError && error.code === "invalid_target");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("DEV-26 databases gain leaf counts without changing the enrolled root; re-enrollment adds no batch", async () => {
  const f = fixture(); const gate = new FakeEnrollmentGate();
  let service = await ObserverEnrollmentService.open(f.db, gate);
  let worker: ObserverRootPublisher | undefined;
  try {
    const commitment = `0x${"01".padStart(64, "0")}`, key = randomBytes(32).toString("base64");
    let challenge = service.issueEnrollmentChallenge(commitment, key);
    const enrolled = service.enroll(challenge.id, commitment, key, Buffer.from([42]));
    service.close();
    const db = new DatabaseSync(f.db); db.exec("ALTER TABLE observer_roots DROP COLUMN leaf_count"); db.close();
    service = await ObserverEnrollmentService.open(f.db, gate);
    const snapshot = service.publicationBatch(0)?.snapshot;
    assert.equal(snapshot?.leafCount, 1); assert.equal(snapshot?.root, enrolled.root);
    worker = new ObserverRootPublisher(f.db, service, f.transport, { batchSize: 1 });
    await worker.tick(); assert.equal(f.transport.wires.length, 1);
    challenge = service.issueEnrollmentChallenge(commitment, key);
    service.enroll(challenge.id, commitment, key, Buffer.from([42]));
    await worker.tick(); assert.equal(f.transport.wires.length, 1);
    assert.equal(service.publicationBatch(1), undefined);
  } finally { await worker?.close(); service.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("a confirmed bootstrap not yet visible at finalized commitment is retried before publication", async () => {
  const f = fixture(), snapshot = f.source.add();
  const signer = Keypair.generate(), program = Keypair.generate().publicKey;
  const signerFile = join(f.dir, "publisher.json");
  writeFileSync(signerFile, JSON.stringify([...signer.secretKey]), { mode: 0o600 });
  const enrollmentData = Buffer.alloc(176);
  discriminator("account", "EnrollmentAuthority").copy(enrollmentData);
  signer.publicKey.toBuffer().copy(enrollmentData, 8);
  enrollmentData.writeBigUInt64LE(1n, 40);
  Buffer.from(snapshot.root.slice(2), "hex").copy(enrollmentData, 48);
  const rootData = Buffer.alloc(84);
  discriminator("account", "ObserverRoot").copy(rootData);
  Buffer.from(snapshot.root.slice(2), "hex").copy(rootData, 8);
  rootData.writeUInt32LE(snapshot.leafCount, 40);
  rootData.writeBigInt64LE(1n, 44);
  signer.publicKey.toBuffer().copy(rootData, 52);
  const account = (data: Buffer, owner: PublicKey, executable = false) => ({
    data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable,
    lamports: 1_000_000, rentEpoch: 0,
  });
  let finalized = false, now = 0;
  const requests: { method: string; params: unknown[] }[] = [];
  const rpc = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const call = JSON.parse(Buffer.concat(parts).toString()) as { id: string; method: string; params: unknown[] };
    requests.push(call);
    let result: unknown;
    if (call.method === "getGenesisHash") result = "local-test-genesis";
    else if (call.method === "getAccountInfo") {
      result = { context: { slot: 50 }, value: call.params[0] === program.toBase58() ?
        account(Buffer.alloc(0), UPGRADEABLE_LOADER, true) : account(enrollmentData, program) };
    } else if (call.method === "getMultipleAccounts") {
      result = { context: { slot: finalized ? 50 : 1 }, value: finalized ?
        [account(rootData, program), account(enrollmentData, program)] : [null, null] };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...(result === undefined ?
      { error: { code: -32601, message: "Unexpected test RPC method" } } : { result }) }));
  });
  let worker: ObserverRootPublisher | undefined;
  try {
    await new Promise<void>(resolve => rpc.listen(0, "127.0.0.1", resolve));
    const address = rpc.address(); assert.ok(address && typeof address !== "string");
    const transport = await SolanaRootPublicationTransport.open(`http://127.0.0.1:${address.port}`, program.toBase58(), signerFile);
    worker = new ObserverRootPublisher(f.db, f.source, transport, { batchSize: 1, now: () => now });
    await worker.tick();
    assert.equal(worker.status().state, "retrying");
    assert.equal(worker.status().lastError, "rpc_error");
    assert.equal(worker.status().confirmed, null);
    finalized = true; now = 1_000; await worker.tick();
    assert.equal(worker.status().state, "confirmed");
    assert.equal(worker.status().confirmed?.root, snapshot.root);
    assert.equal(worker.status().confirmed?.active, true);
    assert.equal(requests.filter(call => call.method === "getMultipleAccounts").length, 2);
    assert.ok(requests.filter(call => call.method === "getMultipleAccounts")
      .every(call => (call.params[1] as { commitment: string }).commitment === "finalized"));
    assert.ok(requests.every(call => ["getGenesisHash", "getAccountInfo", "getMultipleAccounts"].includes(call.method)));
  } finally {
    await worker?.close();
    await new Promise<void>(resolve => rpc.close(() => resolve()));
    rmSync(f.dir, { recursive: true, force: true });
  }
});
