import { buildPoseidon } from "circomlibjs";
import { assertSupportedArity, parseCanonicalFieldElement, toHex32 } from "./field.js";

export interface PoseidonResult {
  decimal: string;
  hex: string;
}

export async function hashCanonicalInputs(
  values: unknown[],
  declaredArity: number,
): Promise<PoseidonResult> {
  assertSupportedArity(declaredArity);
  if (values.length !== declaredArity) {
    throw new RangeError("input count does not match declared Poseidon arity");
  }

  const inputs = values.map(parseCanonicalFieldElement);
  const poseidon = await buildPoseidon();
  const output = poseidon.F.toObject(poseidon(inputs));
  return { decimal: output.toString(10), hex: toHex32(output) };
}
