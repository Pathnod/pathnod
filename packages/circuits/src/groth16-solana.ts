import { parseCanonicalFieldElement, toHex32 } from "./field.js";

export const BN254_BASE_FIELD =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const PUBLIC_INPUT_ORDER = [
  "root", "protocol_id_f", "device_id_f", "epoch", "nullifier", "pseudonym", "class_pub",
] as const;

/** Two runtime meter logs bracketing verification, including the end meter's cost. */
export function verificationComputeUnits(logs: readonly string[]): number {
  const meters = logs.flatMap(line => {
    const match = line.match(/^Program consumption: (\d+) units remaining$/);
    return match ? [Number(match[1])] : [];
  });
  if (meters.length !== 2 || !meters.every(Number.isSafeInteger) || meters[0] <= meters[1]) {
    throw new Error("Expected exactly two decreasing runtime CU meter readings");
  }
  return meters[0] - meters[1];
}

function array(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`Expected ${length} elements`);
  return value;
}

function coordinate(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 77 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Expected canonical decimal Fq coordinate");
  }
  const n = BigInt(value);
  if (n >= BN254_BASE_FIELD) throw new Error("Coordinate exceeds Fq");
  return n;
}

function bytes(n: bigint): Buffer {
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}

export function g1(value: unknown, negate = false): Buffer {
  const [x, y, z] = array(value, 3);
  if (z !== "1") throw new Error("Expected affine G1 point");
  const cy = coordinate(y);
  return Buffer.concat([bytes(coordinate(x)), bytes(negate ? (BN254_BASE_FIELD - cy) % BN254_BASE_FIELD : cy)]);
}

export function g2(value: unknown): Buffer {
  const [x, y, z] = array(value, 3);
  const [z0, z1] = array(z, 2);
  if (z0 !== "1" || z1 !== "0") throw new Error("Expected affine G2 point");
  const [x0, x1] = array(x, 2);
  const [y0, y1] = array(y, 2);
  // snarkjs stores c0,c1; Solana's pairing ABI requires c1,c0.
  return Buffer.concat([x1, x0, y1, y0].map(v => bytes(coordinate(v))));
}

function groth16(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected Groth16 JSON");
  const v = value as Record<string, unknown>;
  if (v.protocol !== "groth16" || v.curve !== "bn128") throw new Error("Expected Groth16/bn128");
  return v;
}

/** Borsh fixed arrays: alpha, beta, gamma, delta, then eight IC points. */
export function convertVerificationKey(value: unknown): Buffer {
  const v = groth16(value);
  if (v.nPublic !== 7) throw new Error("Expected seven public inputs");
  return Buffer.concat([
    g1(v.vk_alpha_1), g2(v.vk_beta_2), g2(v.vk_gamma_2), g2(v.vk_delta_2),
    ...array(v.IC, 8).map(p => g1(p)),
  ]);
}

/** Borsh fixed arrays: negated A, B, C, seven big-endian public inputs. */
export function convertProof(proof: unknown, inputs: unknown): Buffer {
  const p = groth16(proof);
  const publicBytes = array(inputs, 7).map(v => Buffer.from(toHex32(parseCanonicalFieldElement(v)).slice(2), "hex"));
  return Buffer.concat([g1(p.pi_a, true), g2(p.pi_b), g1(p.pi_c), ...publicBytes]);
}
