import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConfidenceInput } from "./confidence.ts";

function publicBytes(key: KeyObject): Buffer {
  if (key.asymmetricKeyType !== "x25519")
    throw Error("Confidence recipient must use X25519");
  return (key.type === "private" ? createPublicKey(key) : key).export({
    format: "der",
    type: "spki",
  }) as Buffer;
}
function sharedKey(
  privateKey: KeyObject,
  publicKey: KeyObject,
  aad: Buffer,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      diffieHellman({ privateKey, publicKey }),
      aad,
      Buffer.from("Pathnod/confidence-encryption/v0"),
      32,
    ),
  );
}
export function sealConfidenceInput(
  recipient: KeyObject,
  target: string,
  hash: string,
  input: ConfidenceInput,
): string {
  publicBytes(recipient);
  const ephemeral = generateKeyPairSync("x25519"),
    iv = randomBytes(12),
    aad = Buffer.from(`${target}/${hash}`);
  const cipher = createCipheriv(
    "aes-256-gcm",
    sharedKey(ephemeral.privateKey, recipient, aad),
    iv,
  );
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    ephemeral: publicBytes(ephemeral.publicKey).toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  });
}
export function openConfidenceInput(
  recipient: KeyObject,
  target: string,
  hash: string,
  sealed: string,
): ConfidenceInput {
  if (sealed.length > 200_000 || recipient.type !== "private")
    throw Error("Invalid encrypted confidence input");
  publicBytes(recipient);
  const value = JSON.parse(sealed) as {
    version: number;
    ephemeral: string;
    iv: string;
    ciphertext: string;
    tag: string;
  };
  if (value.version !== 1) throw Error("Unknown confidence encryption version");
  const ephemeral = createPublicKey({
      key: Buffer.from(value.ephemeral, "base64"),
      type: "spki",
      format: "der",
    }),
    aad = Buffer.from(`${target}/${hash}`);
  publicBytes(ephemeral);
  const iv = Buffer.from(value.iv, "base64"),
    tag = Buffer.from(value.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16)
    throw Error("Invalid confidence encryption framing");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    sharedKey(recipient, ephemeral, aad),
    iv,
  );
  cipher.setAAD(aad);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8"),
  ) as ConfidenceInput;
}
export class ConfidenceRecorder {
  readonly recipient: KeyObject;
  constructor(recipient: KeyObject) {
    publicBytes(recipient);
    this.recipient = recipient;
  }
  initialize(db: DatabaseSync): void {
    db.exec(
      "CREATE TABLE IF NOT EXISTS confidence_inputs_v0 (transcript_hash TEXT PRIMARY KEY, target TEXT NOT NULL, recipient TEXT NOT NULL, sealed TEXT NOT NULL)",
    );
    const recipient = publicBytes(this.recipient).toString("base64");
    if (
      db
        .prepare(
          "SELECT 1 FROM confidence_inputs_v0 WHERE recipient<>? LIMIT 1",
        )
        .get(recipient)
    )
      throw Error("Confidence database uses another requester encryption key");
  }
  record(
    db: DatabaseSync,
    target: string,
    hash: string,
    input: ConfidenceInput,
  ): void {
    const sealed = sealConfidenceInput(this.recipient, target, hash, input);
    db.prepare("INSERT INTO confidence_inputs_v0 VALUES (?,?,?,?)").run(
      hash,
      target,
      publicBytes(this.recipient).toString("base64"),
      sealed,
    );
  }
}
