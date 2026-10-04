export type CborValue =
  | number
  | string
  | Buffer
  | boolean
  | null
  | CborValue[]
  | Map<string | number, CborValue>;

export class CborDecodingError extends Error {
  constructor() {
    super("Invalid App Attest CBOR.");
  }
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function decode(input: Uint8Array): { value: CborValue; bytesRead: number } {
  if (!(input instanceof Uint8Array) || input.byteLength === 0 || input.byteLength > 1_048_576) {
    throw new CborDecodingError();
  }
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;

  function read(count: number): Buffer {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > data.length) {
      throw new CborDecodingError();
    }
    const value = data.subarray(offset, offset + count);
    offset += count;
    return value;
  }

  function argument(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) {
      const value = read(1).readUInt8(0);
      if (value < 24) throw new CborDecodingError();
      return value;
    }
    if (additional === 25) {
      const value = read(2).readUInt16BE(0);
      if (value <= 0xff) throw new CborDecodingError();
      return value;
    }
    if (additional === 26) {
      const value = read(4).readUInt32BE(0);
      if (value <= 0xffff) throw new CborDecodingError();
      return value;
    }
    if (additional === 27) {
      const value = read(8).readBigUInt64BE(0);
      if (value <= 0xffff_ffffn || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CborDecodingError();
      }
      return Number(value);
    }
    throw new CborDecodingError();
  }

  function item(depth: number): CborValue {
    if (depth > 12) throw new CborDecodingError();
    const initial = read(1)[0]!;
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      throw new CborDecodingError();
    }
    const length = argument(additional);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) return read(length);
    if (major === 3) {
      try {
        return textDecoder.decode(read(length));
      } catch {
        throw new CborDecodingError();
      }
    }
    if (major === 4) {
      if (length > data.length) throw new CborDecodingError();
      const values: CborValue[] = [];
      for (let i = 0; i < length; i++) values.push(item(depth + 1));
      return values;
    }
    if (major === 5) {
      if (length > data.length) throw new CborDecodingError();
      const values = new Map<string | number, CborValue>();
      for (let i = 0; i < length; i++) {
        const key = item(depth + 1);
        if (typeof key !== "string" && typeof key !== "number") throw new CborDecodingError();
        if (values.has(key)) throw new CborDecodingError();
        values.set(key, item(depth + 1));
      }
      return values;
    }
    throw new CborDecodingError();
  }

  const value = item(0);
  return { value, bytesRead: offset };
}

export function decodeCbor(input: Uint8Array): CborValue {
  const result = decode(input);
  if (result.bytesRead !== input.byteLength) throw new CborDecodingError();
  return result.value;
}

export function decodeCborPrefix(input: Uint8Array): { value: CborValue; bytesRead: number } {
  return decode(input);
}

export function requireCborMap(value: CborValue, keys: readonly (string | number)[]): Map<string | number, CborValue> {
  if (!(value instanceof Map) || value.size !== keys.length || keys.some((key) => !value.has(key))) {
    throw new CborDecodingError();
  }
  return value;
}
