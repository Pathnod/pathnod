import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { discriminator } from "./index.ts";

export interface ConfidenceAuthorization {
  epoch: number;
  observationRoot: string;
  observerCount: number;
  previousCommitment: string;
  commitment: string;
  policyVersion: number;
  evaluatedAtMilliseconds: bigint;
}
function hex(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error("Invalid confidence hash");
  return Buffer.from(value, "hex");
}
function uint(value: number | bigint, size: number): Buffer {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw Error("Invalid confidence integer");
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(size * 8))
    throw Error("Invalid confidence integer");
  const result = Buffer.alloc(size);
  for (let i = 0; i < size; i++)
    result[i] = Number((n >> BigInt(i * 8)) & 255n);
  return result;
}
export function confidenceAuthorizationBytes(
  args: ConfidenceAuthorization,
): Buffer {
  return Buffer.concat([
    uint(args.epoch, 4),
    hex(args.observationRoot),
    uint(args.observerCount, 2),
    hex(args.previousCommitment),
    hex(args.commitment),
    uint(args.policyVersion, 4),
    uint(args.evaluatedAtMilliseconds, 8),
  ]);
}
export function confidenceAuthorizationDigest(
  program: PublicKey,
  protocol: Uint8Array,
  device: Uint8Array,
  args: ConfidenceAuthorization,
): Buffer {
  if (protocol.length !== 32 || device.length !== 32)
    throw Error("Invalid confidence scope");
  return createHash("sha256")
    .update("Pathnod/confidence-authorization/v0")
    .update(program.toBuffer())
    .update(protocol)
    .update(device)
    .update(confidenceAuthorizationBytes(args))
    .digest();
}
export function publishConfidence(
  program: PublicKey,
  protocol: Uint8Array,
  device: Uint8Array,
  args: ConfidenceAuthorization,
): TransactionInstruction {
  if (protocol.length !== 32 || device.length !== 32)
    throw Error("Invalid confidence scope");
  const pda = (seeds: Uint8Array[]) =>
    PublicKey.findProgramAddressSync(seeds, program)[0];
  return new TransactionInstruction({
    programId: program,
    data: Buffer.concat([
      discriminator("global", "publish_confidence"),
      confidenceAuthorizationBytes(args),
    ]),
    keys: [
      {
        pubkey: pda([Buffer.from("protocol"), protocol]),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: pda([Buffer.from("device"), protocol, device]),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: pda([
          Buffer.from("epoch"),
          protocol,
          device,
          uint(args.epoch, 4),
        ]),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
        isSigner: false,
        isWritable: false,
      },
    ],
  });
}
