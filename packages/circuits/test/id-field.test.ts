import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveDeviceIdField,
  deriveProtocolIdField,
  splitId128,
} from "../src/id-field.js";

interface Vector {
  name: string;
  kind: "protocol" | "device";
  rawIdHex: string;
  domain: string;
  high128: string;
  low128: string;
  expected: string;
  expectedHex: string;
}

test("ID conversion matches the shared canonical vectors", async () => {
  const fixturePath = fileURLToPath(new URL("../../../fixtures/ids/bn254-id-field-v1.json", import.meta.url));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.algorithm, "poseidon");
  assert.equal(fixture.parameterSet, "circom-bn254-x5");
  assert.equal(fixture.rawIdEncoding, "32-byte-big-endian");
  assert.equal(fixture.limbEncoding, "two-unsigned-128-bit-big-endian");
  assert.equal(fixture.outputEncoding, "canonical-bn254-32-byte-big-endian");
  assert.equal(fixture.publicTestData, true);

  const names = new Set<string>();
  for (const vector of fixture.vectors as Vector[]) {
    assert.match(vector.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(!names.has(vector.name));
    names.add(vector.name);
    assert.match(vector.rawIdHex, /^0x[0-9a-f]{64}$/);
    const id = Buffer.from(vector.rawIdHex.slice(2), "hex");
    const [high, low] = splitId128(id);
    assert.equal(high.toString(), vector.high128, vector.name);
    assert.equal(low.toString(), vector.low128, vector.name);
    assert.equal(vector.domain, vector.kind === "protocol" ? "3" : "4");
    const actual = vector.kind === "protocol"
      ? await deriveProtocolIdField(id)
      : await deriveDeviceIdField(id);
    assert.equal(actual.decimal, vector.expected, vector.name);
    assert.equal(actual.hex, vector.expectedHex, vector.name);
  }
  assert.equal(names.size, 4);
});

test("ID conversion rejects malformed widths and separates domains", async () => {
  for (const length of [0, 16, 31, 33]) {
    assert.throws(() => splitId128(new Uint8Array(length)), /exactly 32 bytes/);
  }
  assert.throws(() => splitId128("0".repeat(64) as unknown as Uint8Array), /exactly 32 bytes/);
  const zero = new Uint8Array(32);
  assert.notEqual((await deriveProtocolIdField(zero)).hex, (await deriveDeviceIdField(zero)).hex);
});
