const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

/** Number of base64url characters an unpadded encoding of `byteLength` bytes uses. */
function encodedLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

/**
 * Decode base64url without padding, rejecting anything non-canonical.
 *
 * `Buffer.from(value, "base64url")` is lenient: it accepts padding, the
 * standard alphabet, whitespace, stray characters and non-zero trailing bits.
 * Re-encoding the decoded bytes and comparing with the input rejects every one
 * of those inputs, so a given byte string has exactly one accepted encoding.
 *
 * Returns `undefined` instead of throwing so callers keep their own error code.
 */
export function decodeBase64UrlStrict(value: unknown, expectedByteLength: number): Buffer | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length !== encodedLength(expectedByteLength) || !BASE64URL_ALPHABET.test(value)) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expectedByteLength || decoded.toString("base64url") !== value) {
    return undefined;
  }

  return decoded;
}

/** Encode bytes as base64url without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}
