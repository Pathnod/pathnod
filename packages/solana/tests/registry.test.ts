import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  BN254_MODULUS, activeRoots, decodeDevice, decodeEnrollment, decodeRoot, deviceId,
  discriminator, fieldBytes, publishRoot, registryAddresses,
} from "../src/index.ts";

const program = new PublicKey("5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd");

test("device ID uses the BLE domain separator and the full 32-byte key", () => {
  const key = Buffer.from("5838894a70843a937976156cb1183f8635840f1de06c011dbea12826efbf30ce", "hex");
  assert.equal(deviceId(key).toString("hex"), "2b52d036962219b5195412a33950044c747666eac5d9e88ddfa39dc613b049b8");
  assert.throws(() => deviceId(key.subarray(0, 31)), /32 bytes/);
});

test("device addresses are isolated by protocol, while roots are global", () => {
  const first = registryAddresses(program, Buffer.alloc(32, 1));
  const second = registryAddresses(program, Buffer.alloc(32, 2));
  assert.ok(!first.device(Buffer.alloc(32, 3)).equals(second.device(Buffer.alloc(32, 3))));
  assert.ok(first.root(fieldBytes(42n)).equals(second.root(fieldBytes(42n))));
  assert.ok(first.enrollment.equals(second.enrollment));
});

test("public roots use canonical big-endian field encoding", () => {
  assert.equal(fieldBytes(1n).toString("hex"), `${"00".repeat(31)}01`);
  assert.throws(() => fieldBytes(BN254_MODULUS), /Noncanonical/);
  assert.throws(() => fieldBytes(-1n), /Noncanonical/);
  assert.throws(() => publishRoot(program, PublicKey.default, Buffer.alloc(32, 255), 1), /Noncanonical/);
  assert.throws(() => publishRoot(program, PublicKey.default, fieldBytes(1n), 2 ** 20 + 1), /leaf count/);
});

test("account decoders accept Borsh option compaction and reject invalid tags or padding", () => {
  const data = Buffer.alloc(126);
  discriminator("account", "DeviceRegistry").copy(data);
  data[72] = 1; // curve; both optional fields are None.
  data.writeBigInt64LE(1n, 75);
  data.writeUInt32LE(2, 83);
  const decoded = decodeDevice(data);
  assert.equal(decoded.externalAsset, null);
  assert.equal(decoded.claimedGeohash, null);
  assert.equal(decoded.registeredAt, 1n);
  assert.equal(decoded.capabilities, 2);
  const malformed = Buffer.from(data);
  malformed[73] = 2;
  assert.throws(() => decodeDevice(malformed), /option tag/);
  data[125] = 1;
  assert.throws(() => decodeDevice(data), /trailing data/);
  assert.throws(() => decodeDevice(data.subarray(0, 125)), /Invalid DeviceRegistry/);
});

test("the recent-root window excludes unused zero slots and retains a published zero root", () => {
  const data = Buffer.alloc(176);
  discriminator("account", "EnrollmentAuthority").copy(data);
  assert.deepEqual(activeRoots(decodeEnrollment(data)), []);
  data.writeBigUInt64LE(1n, 40);
  assert.deepEqual(activeRoots(decodeEnrollment(data)), [fieldBytes(0n)]);
  data.writeBigUInt64LE(5n, 40);
  [5n, 2n, 3n, 4n].forEach((value, i) => fieldBytes(value).copy(data, 48 + i * 32));
  assert.deepEqual(activeRoots(decodeEnrollment(data)), [5n, 4n, 3n, 2n].map(fieldBytes));
});

test("a root account binds its exact field, leaf count, timestamp and publisher", () => {
  const data = Buffer.alloc(84);
  discriminator("account", "ObserverRoot").copy(data);
  fieldBytes(42n).copy(data, 8);
  data.writeUInt32LE(1048576, 40);
  data.writeBigInt64LE(1791198157n, 44);
  program.toBuffer().copy(data, 52);
  const root = decodeRoot(data);
  assert.ok(root.root.equals(fieldBytes(42n)) && root.authority.equals(program));
  assert.equal(root.leafCount, 1048576);
  assert.equal(root.publishedAt, 1791198157n);
  data[0] = data[0]! ^ 1;
  assert.throws(() => decodeRoot(data), /Invalid ObserverRoot/);
});
