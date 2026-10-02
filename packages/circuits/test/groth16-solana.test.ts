import assert from "node:assert/strict";
import { test } from "node:test";
import { BN254_BASE_FIELD, convertProof, convertVerificationKey, g1, g2, verificationComputeUnits } from "../src/groth16-solana.js";
import { BN254_SCALAR_FIELD } from "../src/field.js";

const point = ["1", "2", "1"];
const extension = [["3", "4"], ["5", "6"], ["1", "0"]];
const proof = { protocol: "groth16", curve: "bn128", pi_a: point, pi_b: extension, pi_c: point };

test("CU measurement requires two decreasing runtime readings", () => {
  const start = "Program consumption: 390000 units remaining";
  const end = "Program consumption: 276664 units remaining";
  assert.equal(verificationComputeUnits([start, "Program log: something else", end]), 113336);
  for (const logs of [[], [start], [end, start], [start, start], [start, end, end]]) {
    assert.throws(() => verificationComputeUnits(logs));
  }
});

test("A is negated over Fq, not Fr; all coordinates are big endian", () => {
  assert.equal(g1(point, true).subarray(32).toString("hex"), (BN254_BASE_FIELD - 2n).toString(16).padStart(64, "0"));
  assert.equal(g1(point)[31], 1);
  assert.equal(g1(point)[63], 2);
});
test("G2 reverses each Fp2 pair, not byte order", () => {
  const p = g2(extension);
  assert.deepEqual([p[31], p[63], p[95], p[127]], [4, 3, 6, 5]);
});
test("seven public inputs and eight IC points have fixed Borsh widths", () => {
  const converted = convertProof(proof, ["1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(converted.length, 480);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => converted[256 + 32 * i + 31]), [1, 2, 3, 4, 5, 6, 7]);
  const vk = { protocol: "groth16", curve: "bn128", nPublic: 7, vk_alpha_1: point,
    vk_beta_2: extension, vk_gamma_2: extension, vk_delta_2: extension, IC: Array(8).fill(point) };
  assert.equal(convertVerificationKey(vk).length, 960);
  assert.throws(() => convertVerificationKey({ ...vk, IC: Array(7).fill(point) }));
});
test("reject malformed points, wrong protocol and noncanonical scalar inputs", () => {
  assert.throws(() => g1(["1", BN254_BASE_FIELD.toString(), "1"]));
  assert.throws(() => g2([["3", "4"], ["5", "6"], ["0", "0"]]));
  for (const v of ["-1", "01", BN254_SCALAR_FIELD.toString(), 1]) {
    assert.throws(() => convertProof(proof, [v, "0", "0", "0", "0", "0", "0"]));
  }
  assert.throws(() => convertProof(proof, Array(6).fill("0")));
  assert.throws(() => convertProof({ ...proof, curve: "bls12381" }, Array(7).fill("0")));
});
