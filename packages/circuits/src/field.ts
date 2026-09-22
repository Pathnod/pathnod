export const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const SUPPORTED_ARITIES = new Set([1, 2, 3, 5]);

export function parseCanonicalFieldElement(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("field elements must be canonical unsigned base-10 strings");
  }

  const parsed = BigInt(value);
  if (parsed >= BN254_SCALAR_FIELD) {
    throw new RangeError("field element must be smaller than the BN254 scalar field modulus");
  }
  return parsed;
}

export function toHex32(value: bigint): string {
  if (value < 0n || value >= BN254_SCALAR_FIELD) {
    throw new RangeError("value is not a canonical BN254 scalar field element");
  }
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function assertSupportedArity(arity: number): void {
  if (!SUPPORTED_ARITIES.has(arity)) {
    throw new RangeError(`unsupported Pathnod Poseidon arity: ${arity}`);
  }
}
