import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { decodeBase64UrlStrict, encodeBase64Url } from "../src/base64url.ts";
import { PROOF_BYTE_LENGTH } from "../src/contract.ts";

const CANONICAL = "WcbN5PyXCKC4F3bowF2AqxuFzHSpApZGm0lMY6c7NYc";

describe("decodeBase64UrlStrict", () => {
  it("decodes a canonical unpadded encoding", () => {
    const decoded = decodeBase64UrlStrict(CANONICAL, PROOF_BYTE_LENGTH);

    assert.ok(decoded !== undefined);
    assert.equal(decoded.byteLength, PROOF_BYTE_LENGTH);
    assert.equal(encodeBase64Url(decoded), CANONICAL);
  });

  it("round-trips random byte strings", () => {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const bytes = randomBytes(PROOF_BYTE_LENGTH);
      const decoded = decodeBase64UrlStrict(encodeBase64Url(bytes), PROOF_BYTE_LENGTH);

      assert.ok(decoded !== undefined);
      assert.deepEqual(decoded, bytes);
    }
  });

  it("rejects non-canonical and ill-typed inputs", () => {
    const rejected: readonly unknown[] = [
      `${CANONICAL}=`, // padded
      CANONICAL.slice(0, -1), // wrong decoded length
      `${CANONICAL}A`, // too long
      "WcbN5PyXCKC4F3bowF2AqxuFzHSpApZGm0lMY6c7NYf", // non-zero trailing bits
      "WcbN5PyXCKC4F3bowF2AqxuFzHSpApZGm0lMY6c7N+c", // standard base64 alphabet
      "WcbN5PyXCKC4F3bowF2AqxuFzHSpApZGm0lMY6c7N/c", // standard base64 alphabet
      ` ${CANONICAL.slice(1)}`, // leading whitespace
      `${CANONICAL.slice(0, -1)}\n`, // trailing newline
      "",
      undefined,
      null,
      42,
      Buffer.from(CANONICAL, "base64url"),
      { toString: () => CANONICAL },
    ];

    for (const value of rejected) {
      assert.equal(decodeBase64UrlStrict(value, PROOF_BYTE_LENGTH), undefined);
    }
  });

  it("enforces the requested byte length", () => {
    assert.equal(decodeBase64UrlStrict(CANONICAL, PROOF_BYTE_LENGTH - 1), undefined);
    assert.equal(decodeBase64UrlStrict("AAAA", 3)?.byteLength, 3);
  });
});
