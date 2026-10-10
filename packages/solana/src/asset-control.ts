import { createHash } from "node:crypto";
import {
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytes32, type DeviceArgs } from "./index.ts";

export const BUBBLEGUM_V1 = new PublicKey(
  "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",
);
export const ACCOUNT_COMPRESSION_V1 = new PublicKey(
  "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK",
);
export interface CnftControlProof {
  tree: PublicKey;
  owner: PublicKey;
  delegate: PublicKey;
  nonce: bigint;
  index: number;
  root: Uint8Array;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  expiresAt: bigint;
  nodes: PublicKey[];
}
function u64(value: bigint) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw Error("Invalid asset nonce");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}
export function cnftAssetId(tree: PublicKey, nonce: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset"), tree.toBuffer(), u64(nonce)],
    BUBBLEGUM_V1,
  )[0];
}
export function cnftTreeConfig(tree: PublicKey) {
  return PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_V1)[0];
}
export function encodeControlProof(proof: CnftControlProof): Buffer {
  if (
    !Number.isInteger(proof.index) ||
    proof.index < 0 ||
    proof.index >= 2 ** 30 ||
    proof.nodes.length > 30 ||
    proof.owner.equals(PublicKey.default)
  )
    throw Error("Invalid compressed NFT proof");
  const index = Buffer.alloc(4);
  index.writeUInt32LE(proof.index);
  const expiry = Buffer.alloc(8);
  if (
    typeof proof.expiresAt !== "bigint" ||
    proof.expiresAt < 0n ||
    proof.expiresAt > 0x7fff_ffff_ffff_ffffn
  )
    throw Error("Invalid proof expiry");
  expiry.writeBigInt64LE(proof.expiresAt);
  return Buffer.concat([
    Buffer.from([1]),
    proof.tree.toBuffer(),
    proof.owner.toBuffer(),
    proof.delegate.toBuffer(),
    u64(proof.nonce),
    index,
    bytes32(proof.root),
    bytes32(proof.dataHash),
    bytes32(proof.creatorHash),
    expiry,
  ]);
}
export function cnftLeaf(proof: CnftControlProof): Buffer {
  return Buffer.from(
    keccak_256(
      Buffer.concat([
        Buffer.from([1]),
        cnftAssetId(proof.tree, proof.nonce).toBuffer(),
        proof.owner.toBuffer(),
        proof.delegate.toBuffer(),
        u64(proof.nonce),
        bytes32(proof.dataHash),
        bytes32(proof.creatorHash),
      ]),
    ),
  );
}
export function assetControlDigest(
  program: PublicKey,
  requester: PublicKey,
  protocol: Uint8Array,
  args: DeviceArgs,
): Buffer {
  const proof = args.proofOfControl;
  if (
    !proof ||
    !args.externalAsset?.equals(cnftAssetId(proof.tree, proof.nonce))
  )
    throw Error("Asset proof does not match registration");
  if (
    !Number.isInteger(args.capabilities) ||
    args.capabilities < 0 ||
    args.capabilities > 0xffff_ffff ||
    !Number.isInteger(args.curve) ||
    args.curve !== 1
  )
    throw Error("Invalid device metadata");
  if (
    args.claimedGeohash !== null &&
    !/^[0123456789bcdefghjkmnpqrstuvwxyz]{6}$/.test(args.claimedGeohash)
  )
    throw Error("Invalid declared geohash");
  const caps = Buffer.alloc(4);
  caps.writeUInt32LE(args.capabilities);
  const geo =
    args.claimedGeohash === null
      ? Buffer.from([0])
      : Buffer.concat([
          Buffer.from([1]),
          Buffer.from(args.claimedGeohash, "ascii"),
        ]);
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("Pathnod/asset-control/v0"),
        program.toBuffer(),
        requester.toBuffer(),
        bytes32(protocol),
        bytes32(args.deviceId),
        bytes32(args.key),
        Buffer.from([args.curve]),
        args.externalAsset.toBuffer(),
        caps,
        geo,
        encodeControlProof(proof),
      ]),
    )
    .digest();
}
export function assetControlAuthorization(
  program: PublicKey,
  requester: PublicKey,
  protocol: Uint8Array,
  args: DeviceArgs,
  signature: Uint8Array,
) {
  if (!args.proofOfControl || signature.length !== 64)
    throw Error("Missing asset owner signature");
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: args.proofOfControl.owner.toBytes(),
    signature,
    message: assetControlDigest(program, requester, protocol, args),
  });
}
export function controlProofAccounts(proof: CnftControlProof) {
  return [
    SYSVAR_INSTRUCTIONS_PUBKEY,
    proof.tree,
    cnftTreeConfig(proof.tree),
    ACCOUNT_COMPRESSION_V1,
    ...proof.nodes,
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}
