export class DerDecodingError extends Error {
  constructor() {
    super("Invalid App Attest certificate extension.");
  }
}

interface DerElement {
  readonly tag: number;
  readonly value: Buffer;
  readonly next: number;
}

function element(data: Buffer, offset: number): DerElement {
  if (offset + 2 > data.length) throw new DerDecodingError();
  const tag = data[offset]!;
  const firstLength = data[offset + 1]!;
  let length = firstLength;
  let start = offset + 2;
  if (firstLength & 0x80) {
    const count = firstLength & 0x7f;
    if (count === 0 || count > 4 || start + count > data.length || data[start] === 0) {
      throw new DerDecodingError();
    }
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + data[start + i]!;
    if (length < 128) throw new DerDecodingError();
    start += count;
  }
  const next = start + length;
  if (next > data.length) throw new DerDecodingError();
  return { tag, value: data.subarray(start, next), next };
}

function children(data: Buffer): DerElement[] {
  const result: DerElement[] = [];
  for (let offset = 0; offset < data.length;) {
    const child = element(data, offset);
    result.push(child);
    offset = child.next;
  }
  return result;
}

function one(data: Buffer, tag: number): DerElement {
  const parsed = element(data, 0);
  if (parsed.tag !== tag || parsed.next !== data.length) throw new DerDecodingError();
  return parsed;
}

const APP_ATTEST_NONCE_OID = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);

export function extractAppAttestNonce(certificateDer: Buffer): Buffer {
  const certificate = children(one(certificateDer, 0x30).value);
  if (certificate.length !== 3 || certificate[0]?.tag !== 0x30) throw new DerDecodingError();
  const tbs = children(certificate[0].value);
  const extensionFields = tbs.filter((field) => field.tag === 0xa3);
  if (extensionFields.length !== 1) throw new DerDecodingError();
  const extensions = children(one(extensionFields[0]!.value, 0x30).value);
  let nonce: Buffer | undefined;
  for (const extension of extensions) {
    if (extension.tag !== 0x30) throw new DerDecodingError();
    const fields = children(extension.value);
    if (fields[0]?.tag !== 0x06 || !fields[0].value.equals(APP_ATTEST_NONCE_OID)) continue;
    if (nonce !== undefined || fields.length < 2 || fields.length > 3) throw new DerDecodingError();
    const payload = fields.at(-1);
    if (payload?.tag !== 0x04) throw new DerDecodingError();
    if (fields.length === 3 && (fields[1]?.tag !== 0x01 || fields[1].value.length !== 1)) {
      throw new DerDecodingError();
    }
    const sequence = children(one(payload.value, 0x30).value);
    if (sequence.length !== 1) throw new DerDecodingError();
    const value = sequence[0]?.tag === 0xa1
      ? one(sequence[0].value, 0x04)
      : sequence[0];
    if (value?.tag !== 0x04 || value.value.length !== 32) {
      throw new DerDecodingError();
    }
    nonce = value.value;
  }
  if (nonce === undefined) throw new DerDecodingError();
  return nonce;
}
