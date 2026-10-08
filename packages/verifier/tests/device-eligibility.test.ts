import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { registryAddresses, paymentAddresses, UPGRADEABLE_LOADER } from "@pathnod/solana";
import { DeviceEligibilityService, EligibilityError, type EligibilityErrorCode } from "../src/device-eligibility.ts";
import { createEnrollmentServer } from "../src/enrollment-http.ts";
import { ObserverEnrollmentService } from "../src/observer-enrollment.ts";
import { FakeEnrollmentGate } from "./helpers/enrollment-gate.ts";
import { eligibilityAccounts } from "./helpers/eligibility-accounts.ts";

const hex = (bytes: Buffer) => `0x${bytes.toString("hex")}`;
const errorCode = (code: EligibilityErrorCode) => (error: unknown) => error instanceof EligibilityError && error.code === code;
function fixture() {
  const f = eligibilityAccounts();
  let reads = 0;
  const service = new DeviceEligibilityService({ read: async () => { reads++; return f.rows; } }, f.program, hex(f.protocol));
  return { ...f, service, reads: () => reads, slots: () => service.slots(hex(f.device), "42") };
}

test("absent epochs, consumed paid slots, exhausted quotas and free protocols use the five-field spec response", async () => {
  const f = fixture();
  const expected = { registered: true, protocol_id: hex(f.protocol), open_slots: 3, reward: "0.05", policy_version: 3 };
  assert.deepEqual(await f.slots(), expected);
  f.rows[2] = f.epochData(1, 2); assert.deepEqual(await f.slots(), { ...expected, open_slots: 2 });
  f.rows[2] = f.epochData(3, 7); assert.deepEqual(await f.slots(), { ...expected, open_slots: 0 });
  f.rows[2] = f.epochData(4, 7); assert.equal((await f.slots()).open_slots, 0);
  f.config[152] = 0; f.config.writeBigUInt64LE(0n, 144);
  assert.deepEqual(await f.slots(), { ...expected, open_slots: 0, reward: "0" });
});

test("rewards remain exact at micro-unit and u64 boundaries", async () => {
  const f = fixture();
  for (const [value, expected] of [[1n, "0.000001"], [1_000_001n, "1.000001"], [1_000_000n, "1"],
    [18_446_744_073_709_551_615n, "18446744073709.551615"]] as const) {
    f.config.writeBigUInt64LE(value, 144); assert.equal((await f.slots()).reward, expected);
  }
});

test("unknown devices are distinct from unknown protocols or RPC failures", async () => {
  const f = fixture(); f.rows[1] = null;
  assert.deepEqual(await f.slots(), { registered: false, protocol_id: hex(f.protocol), open_slots: 0, reward: "0", policy_version: 3 });
  f.rows[0] = null; await assert.rejects(f.slots, errorCode("protocol_unknown"));
  const unavailable = new DeviceEligibilityService({ read: async () => { throw Error("private RPC credential must not escape"); } }, f.program, hex(f.protocol));
  await assert.rejects(() => unavailable.slots(hex(f.device), "42"), errorCode("rpc_unavailable"));
});

test("malformed IDs and epochs are rejected before reading chain data", async () => {
  const f = fixture();
  for (const value of [undefined, "", "-1", "1.5", "1e2", "01", " 42", "4294967296"]) {
    await assert.rejects(() => f.service.slots(hex(f.device), value), errorCode("invalid_input"));
  }
  for (const value of ["0x01", "g".repeat(64), undefined]) {
    await assert.rejects(() => f.service.slots(value, "42"), errorCode("invalid_input"));
  }
  await assert.rejects(() => f.service.slots(hex(f.device), "42", "0".repeat(64)), errorCode("invalid_input"));
  assert.equal(f.reads(), 0);
  assert.equal((await f.service.slots(f.device.toString("hex").toUpperCase(), "4294967295")).registered, true);
});

test("protocol and epoch PDAs are isolated, with one snapshot per query", async () => {
  const f = fixture(), other = Buffer.alloc(32, 3), requests: PublicKey[][] = [];
  const service = new DeviceEligibilityService({ read: async addresses => { requests.push(addresses); return f.rows; } }, f.program, hex(f.protocol));
  await service.slots(hex(f.device), "0");
  await service.slots(hex(f.device), "1");
  assert.ok(requests[0]![0]!.equals(f.addresses.config));
  assert.ok(requests[0]![1]!.equals(f.addresses.device(f.device)));
  assert.ok(!requests[0]![2]!.equals(requests[1]![2]!));
  other.copy(f.config, 40); registryAddresses(f.program, other).escrow.toBuffer().copy(f.config, 153);
  registryAddresses(f.program, other).config.toBuffer().copy(f.escrow,32);
  await service.slots(hex(f.device), "1", hex(other));
  assert.ok(!requests[2]![0]!.equals(requests[1]![0]!));
  assert.ok(!requests[2]![1]!.equals(requests[1]![1]!));
  assert.ok(!requests[2]![2]!.equals(requests[1]![2]!));
  assert.equal(requests.length, 3);
});

test('DEV-36 quotes net rewards and limits paid slots by escrow funding', async () => {
  const f = fixture(); f.settings.writeUInt16LE(2000,104);
  assert.equal((await f.slots()).reward,'0.04');
  f.escrow.writeBigUInt64LE(50_000n,64); assert.equal((await f.slots()).open_slots,1);
  f.escrow.writeBigUInt64LE(49_999n,64); assert.equal((await f.slots()).open_slots,0);
  f.rows[4]!.owner=PublicKey.default; await assert.rejects(f.slots,errorCode('account_mismatch'));
});

test("wrong owners, discriminators, device keys, mints, escrow and inconsistent counters fail closed", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.rows[0]!.owner = PublicKey.default; },
    (f: ReturnType<typeof fixture>) => { f.rows[1]!.executable = true; },
    (f: ReturnType<typeof fixture>) => { f.config[0] = f.config[0]! ^ 1; },
    (f: ReturnType<typeof fixture>) => { f.deviceData[40] = f.deviceData[40]! ^ 1; },
    (f: ReturnType<typeof fixture>) => { f.config.fill(0, 112, 144); },
    (f: ReturnType<typeof fixture>) => { f.config.fill(0, 153, 185); },
    (f: ReturnType<typeof fixture>) => { f.rows[2] = f.epochData(2, 1); },
    (f: ReturnType<typeof fixture>) => { f.rows[2] = f.epochData(1); f.rows[2]!.owner = PublicKey.default; },
    (f: ReturnType<typeof fixture>) => { f.rows[2] = f.account(Buffer.alloc(74)); },
    (f: ReturnType<typeof fixture>) => { f.rows[1] = null; f.rows[2] = f.epochData(1); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); await assert.rejects(f.slots, errorCode("account_mismatch"));
  }
});

test("HTTP exposes eligibility without enrollment, rejects ambiguous queries and hides RPC errors", async () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), "pathnod-slots-"));
  const enrollment = await ObserverEnrollmentService.open(join(dir, "enrollment.sqlite"), new FakeEnrollmentGate());
  let rpcFails = false;
  const eligibility = new DeviceEligibilityService({ read: async () => {
    if (rpcFails) throw Error("https://private.example/api?token=hidden"); return f.rows;
  } }, f.program, hex(f.protocol));
  const server = createEnrollmentServer(enrollment, undefined, eligibility);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const route = `http://127.0.0.1:${address.port}/devices/${hex(f.device)}/slots`;
    const response = await fetch(route + "?epoch=42");
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-pathnod-epoch-seconds"), "604800");
    assert.deepEqual(await response.json(), await f.slots());
    for (const query of ["", "?epoch=42&epoch=43", "?epoch=42&protocol_id=1&protocol_id=2", "?epoch=42&s_obs=secret", "?epoch=-1"]) {
      assert.equal((await fetch(route + query)).status, 400);
    }
    const method = await fetch(route + "?epoch=42", { method: "POST" });
    assert.equal(method.status, 405); assert.equal(method.headers.get("allow"), "GET");
    f.rows[1] = null; assert.equal((await (await fetch(route + "?epoch=42")).json() as { registered: boolean }).registered, false);
    f.rows[0] = null; assert.equal((await fetch(route + "?epoch=42")).status, 404);
    rpcFails = true;
    const failure = await fetch(route + "?epoch=42"); assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { error: "rpc_unavailable" });
    assert.equal(enrollment.root().revision, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    enrollment.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("the production reader checks its deployment and uses finalized getMultipleAccounts", async () => {
  const f = fixture(); let validProgram = true;
  const requests: { method: string; params: unknown[] }[] = [];
  const encoded = (row: typeof f.rows[number]) => row === null ? null : {
    ...row, owner: row.owner.toBase58(), data: [row.data.toString("base64"), "base64"], rentEpoch: 0,
  };
  const rpc = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
    const call = JSON.parse(Buffer.concat(parts).toString()) as { id: string; method: string; params: unknown[] }; requests.push(call);
    const result = call.method === "getGenesisHash" ? "local-test-genesis" : call.method === "getAccountInfo" ?
      { context: { slot: 50 }, value: validProgram ? encoded({ ...f.account(Buffer.alloc(0)), executable: true, owner: UPGRADEABLE_LOADER }) : null } :
      { context: { slot: 50 }, value: f.rows.map(encoded) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  try {
    await new Promise<void>(resolve => rpc.listen(0, "127.0.0.1", resolve));
    const address = rpc.address(); assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const service = await DeviceEligibilityService.open(endpoint, f.program.toBase58(), hex(f.protocol));
    assert.equal((await service.slots(hex(f.device), "42")).open_slots, 3);
    const call = requests.find(value => value.method === "getMultipleAccounts"); assert.ok(call);
    assert.deepEqual(call.params, [[f.addresses.config, f.addresses.device(f.device), f.addresses.epoch(f.device, 42),
      paymentAddresses(f.program,f.protocol,Buffer.alloc(32)).settings,f.addresses.escrow].map(key => key.toBase58()),
      { encoding: "base64", commitment: "finalized" }]);
    validProgram = false;
    await assert.rejects(() => DeviceEligibilityService.open(endpoint, f.program.toBase58(), hex(f.protocol)), errorCode("invalid_target"));
    await assert.rejects(() => DeviceEligibilityService.open("http://remote.example", f.program.toBase58(), hex(f.protocol)), errorCode("invalid_target"));
    assert.ok(requests.every(value => ["getGenesisHash", "getAccountInfo", "getMultipleAccounts"].includes(value.method)));
  } finally { await new Promise<void>(resolve => rpc.close(() => resolve())); }
});
