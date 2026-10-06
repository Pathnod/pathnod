import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeDeviceEpoch, decodeProtocol, registryAddresses } from "@pathnod/solana";
import { DeviceEligibilityService, type DeviceSlots } from "../src/device-eligibility.ts";
import { createEnrollmentServer } from "../src/enrollment-http.ts";
import { ObserverEnrollmentService, type EnrollmentAttestationGate } from "../src/observer-enrollment.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]!, value = process.argv[i + 1];
  if (!["--rpc", "--registry-report", "--database", "--report"].includes(name) || !value || args.has(name)) {
    throw Error("Usage: eligibility:verify --rpc URL --registry-report FILE --database DB --report FILE");
  }
  args.set(name, value);
}
function required(name: string): string {
  const value = args.get(name); if (!value) throw Error(`Missing ${name}`); return value;
}

async function main() {
  const rpc = new URL(required("--rpc"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  assert.ok(local || rpc.href === "https://api.devnet.solana.com/", "Use localhost or official devnet");
  const registryPath = path.resolve(required("--registry-report"));
  const dbPath = path.resolve(required("--database")), reportPath = path.resolve(required("--report"));
  const repo = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
  for (const filename of [registryPath, dbPath, reportPath]) {
    const relative = path.relative(repo, await realpath(path.dirname(filename)));
    assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Keep generated databases and reports outside Git");
  }
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    program: string; protocolId: string; deviceId: string; rewardMint: string;
  };
  assert.match(registry.protocolId, /^[0-9a-f]{64}$/);
  assert.match(registry.deviceId, /^[0-9a-f]{64}$/);
  const program = new PublicKey(registry.program), protocol = Buffer.from(registry.protocolId, "hex");
  const device = Buffer.from(registry.deviceId, "hex"), addresses = registryAddresses(program, protocol);
  const connection = new Connection(rpc.href, "confirmed");
  const configAccount = await connection.getAccountInfo(addresses.config);
  assert.ok(configAccount && configAccount.owner.equals(program));
  const config = decodeProtocol(configAccount.data);
  const epoch = Math.floor(Date.now() / 1000 / config.epochSeconds);
  const keys = [addresses.config, addresses.device(device), addresses.epoch(device, epoch)];
  const before = await connection.getMultipleAccountsInfo(keys);
  assert.ok(before[1]?.owner.equals(program));
  const used = before[2] === null ? 0 : decodeDeviceEpoch(before[2]!.data).paidSlotsUsed;
  const eligibility = await DeviceEligibilityService.open(rpc.href, registry.program, registry.protocolId, registry.rewardMint);
  const deny = () => { throw Error("Eligibility validation does not enroll observers"); };
  const gate: EnrollmentAttestationGate = { issueChallenge: deny, acceptAttestation: deny, acceptAssertion: deny, getKey: () => undefined };
  const enrollment = await ObserverEnrollmentService.open(dbPath, gate);
  const rootBefore = enrollment.root();
  const server = createEnrollmentServer(enrollment, undefined, eligibility);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const route = `/devices/0x${registry.deviceId}/slots?epoch=${epoch}`;
    const request = async (url: string) => {
      if (!local) await new Promise(resolve => setTimeout(resolve, 1_000));
      return fetch(base + url);
    };
    const response = await request(route); assert.equal(response.status, 200);
    const slots = await response.json() as DeviceSlots;
    assert.deepEqual(Object.keys(slots).sort(), ["open_slots", "policy_version", "protocol_id", "registered", "reward"]);
    assert.equal(slots.registered, true); assert.equal(slots.protocol_id, `0x${registry.protocolId}`);
    assert.equal(slots.open_slots, Math.max(0, config.slotsPerEpoch - used));
    assert.equal(slots.policy_version, config.policyVersion);
    const [whole, fractional = ""] = slots.reward.split(".");
    assert.ok(whole && /^[0-9]+$/.test(whole) && fractional.length <= 6 && /^[0-9]*$/.test(fractional));
    assert.equal(BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0")), config.rewardPerSlot);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const repeat = await request(route); assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), slots);
    const unknown = await request(`/devices/${randomBytes(32).toString("hex")}/slots?epoch=${epoch}`);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { registered: false, protocol_id: slots.protocol_id, open_slots: 0, reward: "0", policy_version: slots.policy_version });
    assert.equal((await request(route + "&epoch=1")).status, 400);
    assert.equal((await request(route + `&protocol_id=${randomBytes(32).toString("hex")}`)).status, 404);
    const after = await connection.getMultipleAccountsInfo(keys);
    after.forEach((account, i) => {
      assert.equal(account === null, before[i] === null);
      if (account && before[i]) {
        assert.ok(account.owner.equals(before[i]!.owner));
        assert.ok(account.data.equals(before[i]!.data), "Eligibility reads changed a chain account");
      }
    });
    assert.deepEqual(enrollment.root(), rootBefore);
    const report = { developmentOnly: true, program: registry.program, cluster: local ? "local" : "devnet",
      protocolId: slots.protocol_id, deviceId: `0x${registry.deviceId}`, epoch, response: slots,
      epochAccountPresent: before[2] !== null, paidSlotsUsed: used,
      config: addresses.config.toBase58(), device: addresses.device(device).toBase58(), deviceEpoch: keys[2]!.toBase58(),
      validation: "HTTP contract, repeat, unknown device/protocol, duplicate query; chain accounts and enrollment root unchanged",
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS: eligibility HTTP contract and read-only chain validation. Report: ${reportPath}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); enrollment.close();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Eligibility validation failed"); process.exitCode = 1; });
