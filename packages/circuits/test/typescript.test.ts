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
  assert.throws(() => parseCanonicalFieldElement("9".repeat(100_000)), RangeError);
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

test("requires every supported arity and unique safe vector names", async () => {
  const fixture = await loadFixture();
  for (const arity of [1, 2, 3, 5]) {
    const withoutArity = structuredClone(fixture);
    withoutArity.vectors = withoutArity.vectors.filter((vector) => vector.arity !== arity);
    assert.throws(() => validateFixture(withoutArity), new RegExp(`missing arity ${arity}`));
  }

  const duplicate = structuredClone(fixture);
  duplicate.vectors[1]!.name = duplicate.vectors[0]!.name;
  assert.throws(() => validateFixture(duplicate), /duplicate Poseidon vector name/);

  for (const name of ["../harmless-review-marker", "nested/file", "-leading", "trailing-", ""]) {
    const unsafe = structuredClone(fixture);
    unsafe.vectors[0]!.name = name;
    assert.throws(() => validateFixture(unsafe), /safe lowercase filename stem/);
  }
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
  const vectors = new Map(fixture.vectors.map((vector) => [vector.name, vector]));

  function assertOnlyCoordinateChanges(leftName: string, rightName: string, coordinate: number): void {
    const left = vectors.get(leftName);
    const right = vectors.get(rightName);
    assert.ok(left, `${leftName} must exist`);
    assert.ok(right, `${rightName} must exist`);
    assert.equal(left.arity, 5);
    assert.equal(right.arity, 5);
    assert.notEqual(left.inputs[coordinate], right.inputs[coordinate]);
    for (let index = 0; index < left.inputs.length; index += 1) {
      if (index !== coordinate) {
        assert.equal(left.inputs[index], right.inputs[index], `${leftName}/${rightName}: input ${index}`);
      }
    }
    assert.notEqual(left.expected, right.expected);
  }

  assertOnlyCoordinateChanges("nullifier-domain-null", "nullifier-domain-pseud", 0);
  assertOnlyCoordinateChanges("nullifier-epoch-17", "nullifier-epoch-18", 4);
  assertOnlyCoordinateChanges("nullifier-device-9001", "nullifier-device-9002", 3);
});
