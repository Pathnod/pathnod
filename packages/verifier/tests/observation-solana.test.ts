import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createServer } from "node:http";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { DEFAULT_OBSERVATION_KEY_DIGEST, discriminator } from "@pathnod/solana";
import { eligibilityAccounts } from "./helpers/eligibility-accounts.ts";
import { SolanaObservationPolicySource } from "../src/observation-solana.ts";
import { decodeObservationTranscript } from "../src/observation-transcript.ts";

function fixture() {
  const f = eligibilityAccounts();
  const vector = JSON.parse(readFileSync(new URL("../../../fixtures/observations/transcript-v0.json", import.meta.url), "utf8")).vectors[0];
  const t = decodeObservationTranscript(Buffer.from(vector.bytes.slice(2), "hex"));
  t.protocolID = f.protocol; t.deviceID = f.device; t.publicKey = f.deviceData.subarray(40, 72);
  const enrollment = Buffer.alloc(176); discriminator("account", "EnrollmentAuthority").copy(enrollment);
  f.program.toBuffer().copy(enrollment, 8); enrollment.writeBigUInt64LE(5n, 40);
  for (let i = 0; i < 4; i++) enrollment[48 + i * 32 + 31] = i + 1;
  f.deviceData.writeUInt32LE(2, 83);
  const rows: (AccountInfo<Buffer> | null)[] = [f.account(f.config), f.account(f.deviceData), f.account(enrollment), null];
  const requests: PublicKey[][] = [];
  const source = new SolanaObservationPolicySource({ read: async addresses => { requests.push(addresses); return rows; } },
    f.program, f.protocol, "synthetic-genesis", -90, 3);
  return { ...f, t, enrollment, rows, requests, source };
}
test("DEV-33 chain source reads exact protocol/device/root/nullifier PDAs and the last four published roots", async () => {
  const f = fixture(), result = await f.source.snapshot(f.t);
  assert.deepEqual(result.roots, ["1", "4", "3", "2"]);
  assert.equal(result.epochSeconds, 604800); assert.equal(result.minimumRSSI, -90);
  assert.equal(result.device?.capabilities, 2); assert.equal(result.nullifierUsed, false);
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0]![0]!.equals(f.addresses.config));
  assert.ok(f.requests[0]![1]!.equals(f.addresses.device(f.device))); assert.ok(f.requests[0]![2]!.equals(f.addresses.enrollment));
  assert.ok(f.requests[0]![3]!.equals(PublicKey.findProgramAddressSync([Buffer.from("obs"), f.t.nullifier], f.program)[0]));
  f.rows[3] = { ...f.account(Buffer.alloc(1)), owner: PublicKey.default };
  assert.equal((await f.source.snapshot(f.t)).nullifierUsed, true);
  f.rows[1] = null; assert.equal((await f.source.snapshot(f.t)).device, undefined);
});
test("DEV-33 chain source rejects invalid owners, account layouts, configured policy and protocol", async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.rows[0] = null; }, f => { f.rows[2] = null; }, f => { f.rows[0]!.owner = PublicKey.default; },
    f => { f.rows[2]!.executable = true; }, f => { f.config[0] = 0; }, f => { f.config.writeUInt32LE(2, 108); },
    f => { f.config.writeUInt32LE(0, 72); }, f => { f.config.fill(0, 153); },
    f => { f.deviceData[8] = f.deviceData[8]! ^ 1; }, f => { f.t.protocolID = Buffer.alloc(32, 3); },
    f => { f.rows.pop(); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(f.source.snapshot(f.t)); }
  const f = fixture();
  const unavailable = new SolanaObservationPolicySource({ read: async () => { throw Error("RPC unavailable"); } }, f.program, f.protocol, "test");
  await assert.rejects(unavailable.snapshot(f.t), /RPC unavailable/);
});
test("DEV-35 signing source pins the circuit metadata in the same finalized snapshot", async () => {
  const f = fixture();
  const metadata = Buffer.concat([
    discriminator("account", "ObservationVerifierInfo"),
    Buffer.from(DEFAULT_OBSERVATION_KEY_DIGEST, "hex"), Buffer.from([1, 7]),
  ]);
  f.rows.push(f.account(metadata));
  const source = new SolanaObservationPolicySource({ read: async addresses => {
    assert.equal(addresses.length, 5);
    assert.ok(addresses[4]!.equals(PublicKey.findProgramAddressSync([Buffer.from("observation-verifier")], f.program)[0]));
    return f.rows;
  } }, f.program, f.protocol, "synthetic-genesis", -90, 3, DEFAULT_OBSERVATION_KEY_DIGEST);
  assert.equal((await source.snapshot(f.t)).nullifierUsed, false);
  metadata[8] = metadata[8]! ^ 1;
  await assert.rejects(source.snapshot(f.t), /circuit key mismatch/);
  metadata[8] = metadata[8]! ^ 1;
  f.rows[4]!.owner = PublicKey.default;
  await assert.rejects(source.snapshot(f.t), /Untrusted/);
  f.rows[4] = null;
  await assert.rejects(source.snapshot(f.t), /Untrusted/);
});
test("DEV-33 production source pins genesis/program and reads one finalized snapshot", async () => {
  const f = fixture(), calls: { method: string; params: unknown[] }[] = [];
  let genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  const encode = (a: AccountInfo<Buffer> | null) => a === null ? null : {
    ...a, owner: a.owner.toBase58(), data: [a.data.toString("base64"), "base64"], rentEpoch: 0,
  };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(Buffer.from(c));
    const call = JSON.parse(Buffer.concat(chunks).toString()); calls.push(call);
    const result = call.method === "getGenesisHash" ? genesis : call.method === "getAccountInfo"
      ? { context: { slot: 123 }, value: { ...encode(f.account(Buffer.alloc(0))), executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" } }
      : { context: { slot: 123 }, value: f.rows.map(encode) };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const source = await SolanaObservationPolicySource.open(url, f.program.toBase58(), f.protocol.toString("hex"), -90, 3);
    assert.deepEqual((await source.snapshot(f.t)).roots, ["1", "4", "3", "2"]);
    assert.equal(calls.filter(c => c.method === "getMultipleAccounts").length, 1);
    assert.deepEqual(calls.find(c => c.method === "getMultipleAccounts")!.params[1], { commitment: "finalized", encoding: "base64" });
    genesis = "wrong-cluster";
    await assert.rejects(SolanaObservationPolicySource.open(url, f.program.toBase58(), f.protocol.toString("hex")), /genesis/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
