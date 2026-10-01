import { hashCanonicalInputs, type PoseidonResult } from "./poseidon.js";

export const ID_BYTE_LENGTH = 32;
export const DOMAIN_PROTOCOL_ID = 3n;
export const DOMAIN_DEVICE_ID = 4n;

export function splitId128(id: Uint8Array): [bigint, bigint] {
  if (!(id instanceof Uint8Array) || id.byteLength !== ID_BYTE_LENGTH) {
    throw new TypeError("ID must be exactly 32 bytes");
  }

  const half = (bytes: Uint8Array): bigint =>
    bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  return [half(id.subarray(0, 16)), half(id.subarray(16, 32))];
}

async function deriveIdField(id: Uint8Array, domain: bigint): Promise<PoseidonResult> {
  const [high, low] = splitId128(id);
  return hashCanonicalInputs([domain.toString(), high.toString(), low.toString()], 3);
}

export function deriveProtocolIdField(id: Uint8Array): Promise<PoseidonResult> {
  return deriveIdField(id, DOMAIN_PROTOCOL_ID);
}

export function deriveDeviceIdField(id: Uint8Array): Promise<PoseidonResult> {
  return deriveIdField(id, DOMAIN_DEVICE_ID);
}
