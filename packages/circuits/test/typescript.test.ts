import assert from "node:assert/strict";
import test from "node:test";
import { BN254_SCALAR_FIELD, parseCanonicalFieldElement } from "../src/field.js";
import { loadFixture, validateFixture } from "../src/fixture.js";
import { hashCanonicalInputs } from "../src/poseidon.js";

test("circomlibjs matches every canonical vector", async () => {
  const fixture = await loadFixture();
  for (const vector of fixture.vectors) {
    const result = await hashCanonicalInputs(vector.inputs, vector.arity);
    assert.equal(result.decimal, vector.expected, vector.name);
    assert.equal(result.hex, vector.expectedHex, `${vector.name} hexadecimal output`);
  }
});

test("rejects non-canonical field values instead of reducing them", () => {
  for (const value of ["-1", BN254_SCALAR_FIELD.toString(), "01", "1.0", "nope", "", 1]) {
    assert.throws(() => parseCanonicalFieldElement(value));
  }
});

test("rejects missing inputs and unsupported arities", async () => {
  await assert.rejects(() => hashCanonicalInputs(["1"], 2));
  await assert.rejects(() => hashCanonicalInputs(["1", "2", "3", "4"], 4));
});

test("rejects malformed fixture entries", async () => {
  const fixture = await loadFixture();
  const malformed = structuredClone(fixture);
  malformed.vectors[0]!.inputs = [];
  assert.throws(() => validateFixture(malformed));
});

test("input order is significant", async () => {
  const fixture = await loadFixture();
  const smoke = fixture.vectors.find((vector) => vector.name === "arity-2-endianness-smoke");
  assert.ok(smoke);
  const reordered = await hashCanonicalInputs([...smoke.inputs].reverse(), smoke.arity);
  assert.notEqual(reordered.decimal, smoke.expected);
});

test("distinguishes field elements 1 and 2 from repeated-byte inputs", async () => {
  const fixture = await loadFixture();
  const expected = new Map(fixture.vectors.map((vector) => [vector.name, vector.expected]));
  assert.equal(
    expected.get("arity-2-endianness-smoke"),
    "7853200120776062878684798364095072458815029376092732009249414926327459813530",
  );
  assert.equal(
    expected.get("arity-2-light-poseidon-docs-byte-pattern"),
    "6030039056180688046538272648816150486962996124743416649616624837554616801680",
  );
});

test("domain, epoch, and device changes produce distinct outputs", async () => {
  const fixture = await loadFixture();
  const expected = new Map(fixture.vectors.map((vector) => [vector.name, vector.expected]));
  assert.notEqual(expected.get("nullifier-domain-null"), expected.get("nullifier-domain-pseud"));
  assert.notEqual(expected.get("nullifier-epoch-17"), expected.get("nullifier-epoch-18"));
  assert.notEqual(expected.get("nullifier-device-9001"), expected.get("nullifier-device-9002"));
});
