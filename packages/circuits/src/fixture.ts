import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertSupportedArity,
  BN254_SCALAR_FIELD,
  parseCanonicalFieldElement,
  SUPPORTED_ARITIES,
  toHex32,
} from "./field.js";

export interface PoseidonVector {
  name: string;
  purpose: string;
  arity: number;
  inputs: string[];
  expected: string;
  expectedHex: string;
}

export interface PoseidonFixture {
  schemaVersion: number;
  algorithm: string;
  parameterSet: string;
  fieldModulus: string;
  inputEncoding: string;
  outputEncoding: string;
  diagnosticHexEncoding: string;
  publicTestData: boolean;
  vectors: PoseidonVector[];
}

export const fixturePath = fileURLToPath(
  new URL("../../../fixtures/poseidon/bn254-circom-v1.json", import.meta.url),
);

export async function loadFixture(): Promise<PoseidonFixture> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as PoseidonFixture;
  validateFixture(fixture);
  return fixture;
}

export function validateFixture(fixture: PoseidonFixture): void {
  if (
    fixture.schemaVersion !== 1 ||
    fixture.algorithm !== "poseidon" ||
    fixture.parameterSet !== "circom-bn254-x5" ||
    fixture.fieldModulus !== BN254_SCALAR_FIELD.toString() ||
    fixture.inputEncoding !== "unsigned-base10-field-element" ||
    fixture.outputEncoding !== "unsigned-base10-field-element" ||
    fixture.diagnosticHexEncoding !== "32-byte-big-endian" ||
    fixture.publicTestData !== true ||
    !Array.isArray(fixture.vectors)
  ) {
    throw new TypeError("invalid Poseidon fixture metadata");
  }

  const names = new Set<string>();
  const coveredArities = new Set<number>();
  for (const vector of fixture.vectors) {
    assertSupportedArity(vector.arity);
    if (
      typeof vector.name !== "string" ||
      vector.name.length > 100 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(vector.name)
    ) {
      throw new TypeError("Poseidon vector name must be a safe lowercase filename stem");
    }
    if (names.has(vector.name)) {
      throw new TypeError(`duplicate Poseidon vector name: ${vector.name}`);
    }
    names.add(vector.name);
    coveredArities.add(vector.arity);
    if (!Array.isArray(vector.inputs) || vector.inputs.length !== vector.arity) {
      throw new RangeError(`${vector.name}: input count does not match declared arity`);
    }
    vector.inputs.forEach(parseCanonicalFieldElement);
    const expected = parseCanonicalFieldElement(vector.expected);
    if (vector.expectedHex !== toHex32(expected)) {
      throw new TypeError(`${vector.name}: expected hexadecimal value is not canonical`);
    }
  }

  for (const arity of SUPPORTED_ARITIES) {
    if (!coveredArities.has(arity)) {
      throw new RangeError(`Poseidon fixture is missing arity ${arity} coverage`);
    }
  }
}
