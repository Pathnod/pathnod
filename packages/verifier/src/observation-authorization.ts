import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { Ed25519Program, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
import { readFile, stat } from "node:fs/promises";

const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export interface ObservationAuthorization {
  transcriptHash: string; nullifier: string; pseudonym: string; observerClass: number; policyVersion: number;
  evidenceHash?: string;
}
export function hex32(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error("Invalid canonical bytes32");
  return Buffer.from(value, "hex");
}
export function authorizationPreimage(value: ObservationAuthorization): Buffer {
  const hash = hex32(value.transcriptHash), nullifier = hex32(value.nullifier), pseudonym = hex32(value.pseudonym);
  if (BigInt(`0x${value.nullifier}`) >= FR || BigInt(`0x${value.pseudonym}`) >= FR ||
      ![1, 2, 3].includes(value.observerClass) || !Number.isInteger(value.policyVersion) ||
      value.policyVersion < 1 || value.policyVersion > 0xffff_ffff) throw Error("Invalid authorization fields");
  const version = Buffer.alloc(4); version.writeUInt32LE(value.policyVersion);
  const evidence = value.evidenceHash === undefined ? Buffer.alloc(32) : hex32(value.evidenceHash);
  const present = evidence.some(byte => byte !== 0);
  return Buffer.concat([Buffer.from(present ? "Pathnod/verified/v1" : "Pathnod/verified/v0", "ascii"), hash,
    ...(present ? [evidence] : []), nullifier, pseudonym,
    Buffer.from([value.observerClass]), version]);
}
export function authorizationDigest(value: ObservationAuthorization): Buffer {
  return createHash("sha256").update(authorizationPreimage(value)).digest();
}
export class ObservationSigner {
  readonly publicKey: string;
  readonly #key: KeyObject;
  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw Error("Expected Ed25519 seed");
    this.#key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der", type: "pkcs8" });
    this.publicKey = new PublicKey(createPublicKey(this.#key).export({ format: "der", type: "spki" }).subarray(-32)).toBase58();
  }
  sign(value: ObservationAuthorization): string { return sign(null, authorizationDigest(value), this.#key).toString("hex"); }
  signClaimDigest(digest: Uint8Array): string {
    if (digest.length !== 32) throw Error('Invalid claim digest');
    return sign(null, digest, this.#key).toString('hex');
  }
}
/** Solana-format local key file; no seed in environment variables, URLs or logs. */
export async function loadObservationSigner(path: string): Promise<ObservationSigner> {
  const key = await loadPrivateKeypair(path);
  return new ObservationSigner(key.secretKey.subarray(0, 32));
}
export async function loadPrivateKeypair(path: string): Promise<Keypair> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) throw Error("Verifier key must be a private, bounded file (chmod 600)");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || value.length !== 64 || value.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw Error("Invalid verifier key file");
  return Keypair.fromSecretKey(Uint8Array.from(value));
}
export function verifyAuthorization(value: ObservationAuthorization, publicKey: string, signature: string): boolean {
  if (!/^[a-f0-9]{128}$/.test(signature)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), new PublicKey(publicKey).toBuffer()]),
      format: "der", type: "spki" });
    return verify(null, authorizationDigest(value), key, Buffer.from(signature, "hex"));
  } catch { return false; }
}
export function authorizationInstruction(value: ObservationAuthorization, publicKey: string, signature: string): TransactionInstruction {
  if (!verifyAuthorization(value, publicKey, signature)) throw Error("Invalid verifier authorization");
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: new PublicKey(publicKey).toBuffer(),
    signature: Buffer.from(signature, "hex"), message: authorizationDigest(value) });
}

/** DEV-15 ABI: A negated exactly once over Fq; G2 c1,c0; seven BE Fr scalars. */
export function relayProofBytes(proof: Record<string, unknown>, inputs: string[]): Buffer {
  const array = (v: unknown, n: number): unknown[] => {
    if (!Array.isArray(v) || v.length !== n) throw Error("Invalid proof shape"); return v;
  };
  const scalar = (v: unknown, modulus: bigint): bigint => {
    if (typeof v !== "string" || v.length > 77 || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) >= modulus) throw Error("Invalid proof scalar");
    return BigInt(v);
  };
  const bytes = (n: bigint) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
  const g1 = (v: unknown, negate: boolean) => {
    const [x, y, z] = array(v, 3); if (z !== "1") throw Error("Invalid affine point");
    const cy = scalar(y, FQ); return Buffer.concat([bytes(scalar(x, FQ)), bytes(negate ? (FQ - cy) % FQ : cy)]);
  };
  if (proof.protocol !== "groth16" || proof.curve !== "bn128") throw Error("Invalid proof protocol");
  const [x, y, z] = array(proof.pi_b, 3), [x0, x1] = array(x, 2), [y0, y1] = array(y, 2);
  if (JSON.stringify(z) !== '["1","0"]') throw Error("Invalid G2 affine point");
  return Buffer.concat([g1(proof.pi_a, true), ...[x1, x0, y1, y0].map(v => bytes(scalar(v, FQ))),
    g1(proof.pi_c, false), ...array(inputs, 7).map(v => bytes(scalar(v, FR)))]);
}
