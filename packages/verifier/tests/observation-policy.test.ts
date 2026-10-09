import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AppAttestGate } from "../src/app-attest-gate.ts";
import type { AppAttestPolicy } from "../src/app-attest.ts";
import { ObserverEnrollmentService } from "../src/observer-enrollment.ts";
import { ObservationPolicyService, ObservationPolicyError, type ObservationPolicySource } from "../src/observation-policy.ts";
import { decodeObservationTranscript, encodeObservationTranscript, type ObservationTranscript } from "../src/observation-transcript.ts";
import type { ObservationEnvelope } from "../src/observation-inbox.ts";
import { PinnedGroth16Verifier } from "../src/observation-groth16.ts";
import { createEnrollmentServer } from "../src/enrollment-http.ts";
import { PublicKey } from "@solana/web3.js";
import { SolanaObservationPolicySource } from "../src/observation-solana.ts";
import { ObservationSigner, verifyAuthorization } from "../src/observation-authorization.ts";
import type { ObservationRelayPayload } from "../src/observation-relay.ts";
import { claimDigest, DEVNET_USDC } from '@pathnod/solana';
import { ConfidenceRecorder, openConfidenceInput } from '../src/confidence-store.ts';
import { confidenceCommitment } from '../src/confidence.ts';

const vector = JSON.parse(readFileSync(new URL("../../../fixtures/observations/transcript-v0.json", import.meta.url), "utf8")).vectors[0];
const policy = { appID: "U5MCCC24G5.xyz.pathnod.appattestspike", environment: "development", allowedValidationCategories: [3], allowedBundleVersions: [] } as const;
const digest = (...values: Uint8Array[]) => { const h = createHash("sha256"); for (const v of values) h.update(v); return h.digest(); };
function head(major: number, size: number): Buffer {
  if (size < 24) return Buffer.from([major << 5 | size]);
  if (size < 256) return Buffer.from([major << 5 | 24, size]);
  const b = Buffer.alloc(3); b[0] = major << 5 | 25; b.writeUInt16BE(size, 1); return b;
}
function cbor(value: string | Buffer | Map<string, Buffer | string>): Buffer {
  if (typeof value === "string") { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, v]) => [cbor(key), cbor(v)])]);
}
async function fixture(capacity = 100, attestPolicy: AppAttestPolicy = policy) {
  const dir = mkdtempSync(join(tmpdir(), "pathnod-dev33-")), path = join(dir, "enrollment.sqlite");
  const gate = new AppAttestGate(path, attestPolicy);
  const enrollment = await ObserverEnrollmentService.open(path, gate);
  const db = new DatabaseSync(path), keyID = randomBytes(32).toString("base64");
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // Explicit synthetic enrolled fixture; Apple certificate attestation is tested separately, never bypassed in runtime.
  db.prepare("INSERT INTO app_attest_keys VALUES (?, ?, ?, 'development', 0, NULL, NULL)")
    .run(keyID, key.publicKey.export({ format: "pem", type: "spki" }).toString(), policy.appID);
  db.prepare("INSERT INTO observer_enrollments VALUES (?, ?, 1, 0, ?)").run(keyID, vector.enrollment.commitment, vector.enrollment.leaf);
  const t = decodeObservationTranscript(Buffer.from(vector.bytes.slice(2), "hex"));
  let now = Number(t.observationTimeMilliseconds), proofValid = true, unavailable = false, proofCalls = 0;
  const snapshot = { device: { key: t.publicKey, curve: 1, capabilities: 2 }, epochSeconds: 60,
    verifier: "", policyVersion: 1,
    minimumRSSI: -90, roots: [BigInt(vector.enrollment.root).toString()], nullifierUsed: false };
  const source: ObservationPolicySource = { target: "test-only/dev33",
    claim: async (_pseudo,key,destination,expiresAt) => ({program:DEVNET_USDC.toBase58(),payout:DEVNET_USDC.toBase58(),mint:DEVNET_USDC.toBase58(),withdrawalKey:key,destination,amount:'40000',nonce:'0',expiresAt:expiresAt!,policyVersion:1}),
    prepareClaim: async () => ({message:'test-only',blockhash:'test-only',lastValidBlockHeight:1}), snapshot: async () => {
    if (unavailable) throw Error("test RPC unavailable"); return snapshot;
  } };
  const proof = { verify: async () => { proofCalls++; return proofValid; } };
  let service = new ObservationPolicyService(path, attestPolicy, source, proof, { clock: () => now, capacity });
  function assertion(bytes: Buffer, assertionCounter = 1): string {
    const hash = createHash("sha256").update("Pathnod/transcript/v0").update(bytes).digest();
    return claimAssertion(hash,assertionCounter);
  }
  function claimAssertion(hash: Buffer, assertionCounter: number, metadata?: { version: string; category: number }): string {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(assertionCounter);
    let extensions: Buffer = Buffer.alloc(0);
    if (metadata) {
      const category = Buffer.alloc(4); category.writeUInt32LE(metadata.category);
      extensions = cbor(new Map<string, Buffer | string>([
        ["apple_validation_category_01", category], ["apple_bundle_version_01", metadata.version],
      ]));
    }
    const auth = Buffer.concat([digest(Buffer.from(policy.appID)), Buffer.from([metadata ? 0x80 : 0]), counter, extensions]);
    return cbor(new Map([["signature", sign("sha256", digest(auth, hash), key.privateKey)], ["authenticatorData", auth]])).toString("base64");
  }
  function envelope(transcript: ObservationTranscript = t, assertionCounter = 1): ObservationEnvelope {
    const bytes = encodeObservationTranscript(transcript);
    return { transcript: bytes.toString("base64"), assertion: assertion(bytes, assertionCounter), key_id: keyID,
      zk: { proof: { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"], protocol: "groth16", curve: "bn128" },
        public: [snapshot.roots[0]!, BigInt(vector.protocolField).toString(), BigInt(vector.deviceField).toString(), String(transcript.epoch),
          BigInt("0x" + Buffer.from(transcript.nullifier).toString("hex")).toString(),
          BigInt("0x" + Buffer.from(transcript.pseudonym).toString("hex")).toString(), String(transcript.observerClass)] } };
  }
  return { dir, path, db, gate, enrollment, t, keyID, snapshot, envelope, assertion, claimAssertion, source,
    get service() { return service; }, get proofCalls() { return proofCalls; },
    setNow: (n: number) => { now = n; }, setProof: (v: boolean) => { proofValid = v; }, setUnavailable: () => { unavailable = true; },
    restart: () => { service.close(); service = new ObservationPolicyService(path, attestPolicy, source, proof, { clock: () => now, capacity }); },
    enableRelay: (signer: ObservationSigner, relayCapacity = capacity) => {
      service.close(); snapshot.verifier = signer.publicKey;
      service = new ObservationPolicyService(path, attestPolicy, source, proof,
        { clock: () => now, capacity, relay: { signer, capacity: relayCapacity } });
    },
    enableConfidence: (confidence: ConfidenceRecorder) => {
      service.close();service=new ObservationPolicyService(path,attestPolicy,source,proof,{clock:()=>now,capacity,confidence});
    },
    close: () => { service.close(); db.close(); enrollment.close(); gate.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function code(expected: string, action: Promise<unknown>) {
  await assert.rejects(action, (error: unknown) => error instanceof ObservationPolicyError && error.code === expected);
}

test('DEV-39 archives exactly one requester-encrypted input atomically with successful validation',async()=>{
  const f=await fixture(),recipient=generateKeyPairSync('x25519');
  try{
    f.enableConfidence(new ConfidenceRecorder(recipient.publicKey));const body=f.envelope(),receipt=await f.service.receive(body);
    const row=f.db.prepare('SELECT * FROM confidence_inputs_v0').get()!;
    const input=openConfidenceInput(recipient.privateKey,String(row.target),String(row.transcript_hash),String(row.sealed));
    assert.deepEqual(input,{transcript:body.transcript,reenrollmentCount:null});assert.ok(!String(row.sealed).includes(f.keyID));
    assert.deepEqual(await f.service.receive(body),receipt);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM confidence_inputs_v0').get()?.n,1);
  }finally{f.close();}
});
test('DEV-39 archive failure rolls back counters and acceptance, allowing an unchanged retry',async()=>{
  const f=await fixture(),recipient=generateKeyPairSync('x25519');
  class FailingRecorder extends ConfidenceRecorder { override record(...args:Parameters<ConfidenceRecorder['record']>):void{super.record(...args);throw Error('archive unavailable');} }
  try{
    f.enableConfidence(new FailingRecorder(recipient.publicKey));const body=f.envelope();await assert.rejects(f.service.receive(body),/archive unavailable/);
    assert.equal(f.db.prepare('SELECT counter FROM app_attest_keys').get()?.counter,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observation_validations_v0').get()?.n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM confidence_inputs_v0').get()?.n,0);
    f.enableConfidence(new ConfidenceRecorder(recipient.publicKey));assert.equal((await f.service.receive(body)).status,'validated');
  }finally{f.close();}
});
test('DEV-39 serves a report only while finalized hash, count, root and policy remain current',async()=>{
  const f=await fixture(),device=Buffer.from(f.t.deviceID).toString('hex'),root='11'.repeat(32),report={scope:{deviceID:device,epoch:42,program:DEVNET_USDC.toBase58(),protocolID:Buffer.from(f.t.protocolID).toString('hex'),policyVersion:1,observationRoot:root,transcriptOrder:['22'.repeat(32)]}},hash=confidenceCommitment(report);
  let state={program:report.scope.program,protocolID:report.scope.protocolID,policyVersion:1,observationRoot:root,observerCount:1,commitment:hash};
  f.source.confidenceState=async()=>state;
  try{
    f.db.exec('CREATE TABLE confidence_reports_v0 (device_id TEXT,epoch INTEGER,target TEXT,commitment TEXT,report TEXT,signature TEXT)');
    f.db.prepare('INSERT INTO confidence_reports_v0 VALUES (?,?,?,?,?,?)').run(device,42,f.source.target,hash,JSON.stringify(report),'public-test-signature');
    assert.equal((await f.service.confidenceStatus(device,42))?.status,'published');
    state={...state,policyVersion:2};assert.equal((await f.service.confidenceStatus(device,42))?.status,'stale');
    state={...state,policyVersion:1,commitment:'00'.repeat(32)};assert.equal((await f.service.confidenceStatus(device,42))?.confidence,null);
  }finally{f.close();}
});

test("DEV-34: only successful fresh validation atomically signs and queues one private-data-free job", async () => {
  const f = await fixture(), signer = new ObservationSigner(Buffer.alloc(32, 7));
  try {
    f.enableRelay(signer);
    await code("E_ASSERTION", f.service.receive({ ...f.envelope(), assertion: "Kg==" }));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n, 0);
    const envelope = f.envelope();
    const receipts = await Promise.all([f.service.receive(envelope), f.service.receive(envelope)]);
    assert.deepEqual(receipts[0], receipts[1]);
    const rows = f.db.prepare("SELECT * FROM observation_relay_jobs").all(); assert.equal(rows.length, 1);
    const payload = JSON.parse(String(rows[0]!.payload)) as ObservationRelayPayload;
    assert.ok(verifyAuthorization(payload, signer.publicKey, payload.verifierSignature));
    assert.equal(payload.transcriptHash, receipts[0]!.transcript_hash);
    assert.equal(payload.proofBytes.length, 960);
    for (const forbidden of ["assertion", "key_id", "transcript", "s_obs", "geohash"]) {
      assert.ok(!Object.hasOwn(payload, forbidden));
    }
    assert.ok(!String(rows[0]!.payload).includes(f.keyID));
    assert.equal(f.gate.getKey(f.keyID)!.counter, 1);
    f.enableRelay(signer); await f.service.receive(envelope);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n, 1);
  } finally { f.close(); }
});
test('DEV-36 first withdrawal requires the attested observation owner and fresh destination-bound assertion', async () => {
  const f=await fixture(); const signer=new ObservationSigner(Buffer.alloc(32,7));
  try {
    f.enableRelay(signer);
    const request={pseudonym:Buffer.from(f.t.pseudonym).toString('hex'),withdrawal_key:DEVNET_USDC.toBase58(),destination:DEVNET_USDC.toBase58(),key_id:f.keyID,expires_at:'2000000000',assertion:''};
    const authorization=await f.source.claim!(request.pseudonym,request.withdrawal_key,request.destination,request.expires_at);
    request.assertion=f.claimAssertion(claimDigest(authorization),2);
    await code('E_ASSERTION',f.service.authorizeClaim(request));
    await f.service.receive(f.envelope());
    await code('E_ASSERTION',f.service.authorizeClaim({...request,destination:PublicKey.default.toBase58()}));
    assert.equal(f.gate.getKey(f.keyID)!.counter,1);
    const result=await f.service.authorizeClaim(request);
    assert.equal(result.signature,signer.signClaimDigest(claimDigest(authorization)));
    assert.equal(f.gate.getKey(f.keyID)!.counter,2);
    await code('E_ASSERTION',f.service.authorizeClaim(request));
  } finally { f.close(); }
});
test('DEV-41 observations and withdrawals preserve new signed metadata and reject downgrades after restart', async () => {
  const f = await fixture(100, { ...policy, allowedBundleVersions: ['1'], allowedValidationCategories: [3, 4] });
  const signer = new ObservationSigner(Buffer.alloc(32, 7));
  try {
    f.enableRelay(signer);
    const envelope = f.envelope();
    const transcriptHash = createHash('sha256').update('Pathnod/transcript/v0').update(Buffer.from(envelope.transcript, 'base64')).digest();
    envelope.assertion = f.claimAssertion(transcriptHash, 1, { version: '1', category: 3 });
    await f.service.receive(envelope);
    assert.equal(f.gate.getKey(f.keyID)?.validationCategory, 3);
    assert.equal(f.gate.getKey(f.keyID)?.bundleVersion, '1');

    // Start with an unknown category to exercise the withdrawal upgrade independently.
    f.db.prepare('UPDATE app_attest_keys SET validation_category=NULL WHERE key_id=?').run(f.keyID);
    const request = { pseudonym: Buffer.from(f.t.pseudonym).toString('hex'), withdrawal_key: DEVNET_USDC.toBase58(),
      destination: DEVNET_USDC.toBase58(), key_id: f.keyID, expires_at: '2000000000', assertion: '' };
    const authorization = await f.source.claim!(request.pseudonym, request.withdrawal_key, request.destination, request.expires_at);
    request.assertion = f.claimAssertion(claimDigest(authorization), 2, { version: '1', category: 3 });
    await f.service.authorizeClaim(request);
    assert.equal(f.gate.getKey(f.keyID)?.validationCategory, 3);
    assert.equal(f.gate.getKey(f.keyID)?.counter, 2);
    f.restart(); f.enableRelay(signer);
    await code('E_ASSERTION', f.service.authorizeClaim({ ...request, assertion: f.claimAssertion(claimDigest(authorization), 3) }));
    await code('E_ASSERTION', f.service.authorizeClaim({ ...request,
      assertion: f.claimAssertion(claimDigest(authorization), 3, { version: '1', category: 4 }) }));
    assert.equal(f.gate.getKey(f.keyID)?.counter, 2);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observation_relay_jobs').get()!.n, 1);
  } finally { f.close(); }
});
test("DEV-34: historical receipts cannot enqueue; key mismatch and capacity never consume counters", async () => {
  const f = await fixture(), signer = new ObservationSigner(Buffer.alloc(32, 7));
  try {
    const envelope = f.envelope(); await f.service.receive(envelope); f.enableRelay(signer);
    await f.service.receive(envelope);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n, 0);
    assert.equal(f.gate.getKey(f.keyID)!.counter, 1);
  } finally { f.close(); }
  const fresh = await fixture();
  try {
    fresh.enableRelay(signer, 1);
    fresh.snapshot.verifier = new ObservationSigner(Buffer.alloc(32, 8)).publicKey;
    await code("observation_dependency_unavailable", fresh.service.receive(fresh.envelope()));
    assert.equal(fresh.gate.getKey(fresh.keyID)!.counter, 0);
    fresh.snapshot.verifier = signer.publicKey;
    fresh.db.prepare("INSERT INTO observation_relay_jobs (nullifier, transcript_hash, payload, status) VALUES (?, ?, '{}', 'failed')")
      .run("0".repeat(64), "0".repeat(64));
    await code("observation_capacity", fresh.service.receive(fresh.envelope()));
    assert.equal(fresh.gate.getKey(fresh.keyID)!.counter, 0);
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS n FROM observation_device_counters_v0").get()!.n, 0);
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS n FROM observation_validations_v0").get()!.n, 0);
  } finally { fresh.close(); }
});
test("DEV-33: all nine rejection codes, genuine Ed25519/P256 signatures, no mutation on failure", async () => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>, e: ObservationEnvelope) => void][] = [
    ["E_DEVICE_UNKNOWN", f => { f.snapshot.device.key = Buffer.alloc(32); }],
    ["E_DEV_SIG", (f, e) => { const t = structuredClone(f.t); t.challenges[1]!.signature[0] = t.challenges[1]!.signature[0]! ^ 1; Object.assign(e, f.envelope(t)); }],
    ["E_DEV_COUNTER", (f, e) => { f.db.prepare("INSERT INTO observation_device_counters_v0 VALUES (?, 1)").run(Buffer.from(f.t.deviceID).toString("hex")); }],
    ["E_RTT", (f, e) => { const t = structuredClone(f.t); t.challenges.forEach(c => { c.roundTripMilliseconds = 401; }); Object.assign(e, f.envelope(t)); }],
    ["E_EPOCH", f => { f.setNow(Number(f.t.observationTimeMilliseconds) + 600_001); }],
    ["E_ASSERTION", (_, e) => { e.assertion = "Kg=="; }],
    ["E_ZK", f => { f.setProof(false); }],
    ["E_NULLIFIER", f => { f.snapshot.nullifierUsed = true; }],
    ["E_RSSI", (f, e) => { const t = structuredClone(f.t); t.local.rssiSamples.fill(-91); Object.assign(e, f.envelope(t)); }],
  ];
  for (const [expected, alter] of cases) {
    const f = await fixture();
    try {
      f.enableRelay(new ObservationSigner(Buffer.alloc(32, 7)));
      const e = f.envelope(); alter(f, e); await code(expected, f.service.receive(e));
      assert.equal(f.gate.getKey(f.keyID)!.counter, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_validations_v0").get()!.n, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n, 0);
    } finally { f.close(); }
  }
});
test("DEV-34: failed durable handoff rolls back counters and receipt; exact retry succeeds", async () => {
  const f = await fixture();
  try {
    f.enableRelay(new ObservationSigner(Buffer.alloc(32, 7)));
    f.db.exec("CREATE TRIGGER reject_relay BEFORE INSERT ON observation_relay_jobs BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
    const envelope = f.envelope();
    await assert.rejects(f.service.receive(envelope), /injected storage failure/);
    assert.equal(f.gate.getKey(f.keyID)!.counter, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_device_counters_v0").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_validations_v0").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n, 0);
    f.db.exec("DROP TRIGGER reject_relay"); await f.service.receive(envelope);
    assert.equal(f.gate.getKey(f.keyID)!.counter, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n, 1);
  } finally { f.close(); }
});
test("DEV-33: accepted boundaries, durable idempotence and simultaneous identical retries", async () => {
  const f = await fixture();
  try {
    f.t.challenges.forEach(c => { c.roundTripMilliseconds = 400; }); f.t.local.rssiSamples.fill(-90);
    f.setNow(Number(f.t.observationTimeMilliseconds) + 600_000);
    const e = f.envelope(), receipts = await Promise.all([f.service.receive(e), f.service.receive(e)]);
    assert.deepEqual(receipts[0], receipts[1]); assert.equal(receipts[0]!.policy_validated, true);
    assert.equal(f.gate.getKey(f.keyID)!.counter, 1);
    f.restart(); f.setUnavailable();
    assert.deepEqual(await f.service.receive(e), receipts[0]);
    await code("E_NULLIFIER", f.service.receive({ ...e, assertion: "Kg==" }));
    const disk = readFileSync(f.path);
    assert.ok(!disk.includes(Buffer.from(e.transcript))); assert.ok(!disk.includes(Buffer.from(e.assertion)));
  } finally { f.close(); }
});
test("DEV-33: epoch arithmetic, both freshness boundaries, unknown/revoked/class keys and root/public binding", async () => {
  const f = await fixture();
  try {
    f.setNow(Number(f.t.observationTimeMilliseconds) - 600_000);
    const e = f.envelope();
    f.snapshot.epochSeconds = 61; await code("E_EPOCH", f.service.receive(e)); f.snapshot.epochSeconds = 60;
    f.setNow(Number(f.t.observationTimeMilliseconds) - 600_001); await code("E_EPOCH", f.service.receive(e));
    f.setNow(Number(f.t.observationTimeMilliseconds));
    await code("E_ASSERTION", f.service.receive({ ...e, key_id: "unknown" }));
    const otherClass = structuredClone(f.t); otherClass.observerClass = 2;
    await code("E_ASSERTION", f.service.receive(f.envelope(otherClass)));
    f.snapshot.roots = []; await code("E_ZK", f.service.receive(e)); f.snapshot.roots = [e.zk.public[0]!];
    for (let i = 1; i < 7; i++) {
      const bad = structuredClone(e); bad.zk.public[i] = "0"; await code("E_ZK", f.service.receive(bad));
    }
    f.service.revoke(f.keyID); await code("E_ASSERTION", f.service.receive(e));
  } finally { f.close(); }
});
test("DEV-33: retryable dependency failures, counter capability, capacity rollback and cross-target refusal", async () => {
  const f = await fixture(1);
  try {
    f.snapshot.device.capabilities = 0;
    f.db.prepare("INSERT INTO observation_device_counters_v0 VALUES (?, 999)").run(Buffer.from(f.t.deviceID).toString("hex"));
    await f.service.receive(f.envelope());
    const t = structuredClone(f.t); t.nullifier = Buffer.alloc(32, 1);
    await code("observation_capacity", f.service.receive(f.envelope(t, 2)));
    assert.equal(f.gate.getKey(f.keyID)!.counter, 1);
    f.setUnavailable(); await code("observation_dependency_unavailable", f.service.receive(f.envelope(t, 2)));
    assert.throws(() => new ObservationPolicyService(f.path, policy,
      { target: "different-chain", snapshot: async () => f.snapshot }, { verify: async () => true }), /another chain/);
  } finally { f.close(); }
});
test("DEV-33: short RSSI arrays yield E_RSSI rather than a generic framing rejection", async () => {
  const f = await fixture();
  try {
    const e = f.envelope(), bytes = Buffer.from(e.transcript, "base64");
    bytes.writeUInt32LE(4, 490); const short = Buffer.concat([bytes.subarray(0, 494), bytes.subarray(495)]);
    e.transcript = short.toString("base64");
    e.assertion = f.assertion(short);
    const decoded = decodeObservationTranscript(short, 0); assert.equal(decoded.local.rssiSamples.length, 4);
    const { parseObservationEnvelope } = await import("../src/observation-inbox.ts");
    assert.equal((await parseObservationEnvelope(e, true)).publicInputsMatch, true);
    await code("E_RSSI", f.service.receive(e));
  } finally { f.close(); }
});
test("DEV-33: HTTP validated contract and stable 422/503 rejections", async () => {
  const f = await fixture(), server = createEnrollmentServer(f.enrollment, undefined, undefined, undefined, f.service);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const post = (e: unknown) => fetch(`http://127.0.0.1:${address.port}/observations`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) });
    const e = f.envelope(); const bad = await post({ ...e, assertion: "Kg==" });
    assert.equal(bad.status, 422); assert.deepEqual(await bad.json(), { error: "E_ASSERTION" });
    const good = await post(e); assert.equal(good.status, 202); assert.equal((await good.json() as { status: string }).status, "validated");
    f.setUnavailable(); const t = structuredClone(f.t); t.nullifier = Buffer.alloc(32, 1);
    assert.equal((await post(f.envelope(t, 2))).status, 503);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});
test("DEV-33: unsupported protocol is permanent without RPC or mutation; chain failures remain retryable", async () => {
  const f = await fixture();
  const program = new PublicKey("5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd");
  let rpcCalls = 0, outage = true;
  const reader = { read: async () => {
    rpcCalls++;
    if (outage) throw Error("test RPC outage");
    return [null, null, null, null]; // Missing/untrusted state is not a permanent input rejection.
  } };
  const unsupportedProtocol = Buffer.from(f.t.protocolID);
  unsupportedProtocol[0] = unsupportedProtocol[0]! ^ 1;
  let source = new SolanaObservationPolicySource(reader, program, unsupportedProtocol, "test-only");
  const checked = new ObservationPolicyService(f.path, policy,
    { target: "test-only/dev33", snapshot: t => source.snapshot(t) },
    { verify: async () => { assert.fail("rejected input must not reach proof verification"); } },
    { clock: () => Number(f.t.observationTimeMilliseconds) });
  const server = createEnrollmentServer(f.enrollment, undefined, undefined, undefined, checked);
  const unchanged = () => {
    assert.equal(f.gate.getKey(f.keyID)!.counter, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_device_counters_v0").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_validations_v0").get()!.n, 0);
  };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const envelope = f.envelope();
    const post = () => fetch(`http://127.0.0.1:${address.port}/observations`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
    // Use the real Solana source, not a mock throwing the expected policy error.
    const unsupported = await post();
    assert.equal(unsupported.status, 422);
    assert.deepEqual(await unsupported.json(), { error: "E_DEVICE_UNKNOWN" });
    assert.equal(rpcCalls, 0); unchanged();
    source = new SolanaObservationPolicySource(reader, program, Buffer.from(f.t.protocolID), "test-only");
    const unavailable = await post();
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "observation_dependency_unavailable" });
    assert.equal(rpcCalls, 1); unchanged();
    outage = false;
    const untrusted = await post();
    assert.equal(untrusted.status, 503);
    assert.deepEqual(await untrusted.json(), { error: "observation_dependency_unavailable" });
    assert.equal(rpcCalls, 2); unchanged();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); checked.close(); f.close();
  }
});
test("DEV-33: actual Mopro proof, pinned VK, and real device/test-observer signatures", async () => {
  const f = await fixture();
  try {
    const vkPath = new URL("../../../fixtures/observations/dev33-verification-key.json", import.meta.url).pathname;
    const vk = readFileSync(vkPath);
    const proof = new PinnedGroth16Verifier(vkPath, createHash("sha256").update(vk).digest("hex"));
    assert.throws(() => new PinnedGroth16Verifier(vkPath, "0".repeat(64)), /digest/);
    const service = new ObservationPolicyService(f.path, policy, {
      target: "test-only/dev33", snapshot: async () => f.snapshot,
    }, proof, { clock: () => Number(f.t.observationTimeMilliseconds) });
    try {
      const e = f.envelope(); e.zk = JSON.parse(readFileSync(new URL("../../../fixtures/observations/dev33-proof.json", import.meta.url), "utf8"));
      const bad = structuredClone(e); bad.zk.proof.pi_a[0] = "0";
      await code("E_ZK", service.receive(bad));
      assert.equal((await service.receive(e)).policy_validated, true);
    } finally { service.close(); }
  } finally { f.close(); }
});

test("DEV-33: counter CAS observes concurrent enrollment updates and revocation during proof", async () => {
  for (const revoke of [false, true]) {
    const f = await fixture();
    try {
      const service = new ObservationPolicyService(f.path, policy, { target: "test-only/dev33", snapshot: async () => f.snapshot },
        { verify: async () => {
          if (revoke) f.service.revoke(f.keyID);
          else f.db.prepare("UPDATE app_attest_keys SET counter=1 WHERE key_id=?").run(f.keyID);
          return true;
        } }, { clock: () => Number(f.t.observationTimeMilliseconds) });
      try { await code("E_ASSERTION", service.receive(f.envelope())); }
      finally { service.close(); }
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_validations_v0").get()!.n, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM observation_device_counters_v0").get()!.n, 0);
    } finally { f.close(); }
  }
});
test("DEV-33: dependency exception and freshness expiry during proof never consume counters", async () => {
  for (const timeout of [false, true]) {
    const f = await fixture();
    try {
      // Use a separate clock advanced by the verifier to exercise final acceptance, not only the early check.
      let now = Number(f.t.observationTimeMilliseconds);
      const checked = new ObservationPolicyService(f.path, policy, { target: "test-only/dev33", snapshot: async () => f.snapshot },
        { verify: async () => { if (timeout) throw Error("proof unavailable"); now += 600_001; return true; } }, { clock: () => now });
      try { await code(timeout ? "observation_dependency_unavailable" : "E_EPOCH", checked.receive(f.envelope())); }
      finally { checked.close(); }
      assert.equal(f.gate.getKey(f.keyID)!.counter, 0);
    } finally { f.close(); }
  }
});
