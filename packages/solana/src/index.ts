import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function discriminator(namespace: "global" | "account", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

export function bytes32(value: Uint8Array): Buffer {
  if (value.length !== 32) throw new Error("Expected exactly 32 bytes");
  return Buffer.from(value);
}

export function fieldBytes(value: bigint): Buffer {
  if (value < 0n || value >= BN254_MODULUS) throw new Error("Noncanonical BN254 field element");
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

export function deviceId(key: Uint8Array): Buffer {
  return createHash("sha256").update("Pathnod/device/v0").update(bytes32(key)).digest();
}

function u32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("Invalid u32");
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("Invalid u8");
  return Buffer.from([value]);
}

function option(value: Uint8Array | null): Buffer {
  return value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), value]);
}

export function registryAddresses(program: PublicKey, protocol: Uint8Array) {
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  return {
    config: pda(Buffer.from("protocol"), bytes32(protocol)),
    escrow: pda(Buffer.from("escrow"), bytes32(protocol)),
    enrollment: pda(Buffer.from("enrollment-authority")),
    device: (id: Uint8Array) => pda(Buffer.from("device"), bytes32(protocol), bytes32(id)),
    epoch: (id: Uint8Array, epoch: number) => pda(Buffer.from("epoch"), bytes32(protocol), bytes32(id), u32(epoch)),
    root: (root: Uint8Array) => pda(Buffer.from("root"), bytes32(root)),
  };
}

function meta(pubkey: PublicKey, isWritable = false, isSigner = false) {
  return { pubkey, isWritable, isSigner };
}

function instruction(programId: PublicKey, name: string, data: Uint8Array, keys: TransactionInstruction["keys"]) {
  return new TransactionInstruction({ programId, keys, data: Buffer.concat([discriminator("global", name), data]) });
}

export function initializeEnrollmentAuthority(program: PublicKey, upgradeAuthority: PublicKey, authority: PublicKey) {
  const enrollment = registryAddresses(program, Buffer.alloc(32)).enrollment;
  const programData = PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE_LOADER)[0];
  return instruction(program, "initialize_enrollment_authority", authority.toBuffer(), [
    meta(enrollment, true), meta(program), meta(programData), meta(upgradeAuthority, true, true), meta(SystemProgram.programId),
  ]);
}

export interface ProtocolArgs {
  protocolId: Uint8Array;
  epochSeconds: number;
  verifier: PublicKey;
  policyVersion: number;
  rewardPerSlot: bigint;
  slotsPerEpoch: number;
}

export function initProtocol(program: PublicKey, authority: PublicKey, mint: PublicKey, args: ProtocolArgs) {
  const addresses = registryAddresses(program, args.protocolId);
  return instruction(program, "init_protocol", Buffer.concat([
    bytes32(args.protocolId), u32(args.epochSeconds), args.verifier.toBuffer(),
    u32(args.policyVersion), u64(args.rewardPerSlot), u8(args.slotsPerEpoch),
  ]), [meta(addresses.config, true), meta(addresses.escrow, true), meta(mint), meta(authority, true, true),
    meta(TOKEN_PROGRAM), meta(SystemProgram.programId)]);
}

export interface DeviceArgs {
  deviceId: Uint8Array;
  key: Uint8Array;
  curve: number;
  capabilities: number;
  externalAsset: PublicKey | null;
  claimedGeohash: string | null;
}

export function registerDevice(program: PublicKey, authority: PublicKey, protocol: Uint8Array, args: DeviceArgs) {
  const addresses = registryAddresses(program, protocol);
  if (args.claimedGeohash !== null && !/^[0123456789bcdefghjkmnpqrstuvwxyz]{6}$/.test(args.claimedGeohash)) {
    throw new Error("Invalid declared geohash6");
  }
  return instruction(program, "register_device", Buffer.concat([
    bytes32(args.deviceId), bytes32(args.key), u8(args.curve), option(args.externalAsset?.toBuffer() ?? null),
    Buffer.from([0]), u32(args.capabilities), option(args.claimedGeohash === null ? null : Buffer.from(args.claimedGeohash, "ascii")),
  ]), [meta(addresses.config), meta(addresses.device(args.deviceId), true), meta(authority, true, true), meta(SystemProgram.programId)]);
}

export function publishRoot(program: PublicKey, authority: PublicKey, root: Uint8Array, leafCount: number) {
  const addresses = registryAddresses(program, Buffer.alloc(32));
  const value = BigInt(`0x${bytes32(root).toString("hex")}`);
  if (value >= BN254_MODULUS) throw new Error("Noncanonical BN254 root");
  if (!Number.isInteger(leafCount) || leafCount < 0 || leafCount > 2 ** 20) throw new Error("Invalid depth-20 leaf count");
  return instruction(program, "publish_root", Buffer.concat([bytes32(root), u32(leafCount)]), [
    meta(addresses.enrollment, true), meta(addresses.root(root), true), meta(authority, true, true), meta(SystemProgram.programId),
  ]);
}

class Reader {
  private offset = 8;
  private readonly data: Buffer;
  constructor(data: Uint8Array, name: string, length: number) {
    this.data = Buffer.from(data);
    if (this.data.length !== length || !this.data.subarray(0, 8).equals(discriminator("account", name))) {
      throw new Error(`Invalid ${name} account`);
    }
  }
  bytes(n: number): Buffer {
    if (this.offset + n > this.data.length) throw new Error("Truncated account");
    const result = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return result;
  }
  key() { return new PublicKey(this.bytes(32)); }
  u8() { return this.bytes(1)[0]!; }
  u16() { return this.bytes(2).readUInt16LE(); }
  u32() { return this.bytes(4).readUInt32LE(); }
  u64() { return this.bytes(8).readBigUInt64LE(); }
  i64() { return this.bytes(8).readBigInt64LE(); }
  optional(n: number): Buffer | null {
    const tag = this.u8();
    if (tag !== 0 && tag !== 1) throw new Error("Invalid Borsh option tag");
    return tag === 0 ? null : this.bytes(n);
  }
  finish() {
    if (this.data.subarray(this.offset).some(byte => byte !== 0)) throw new Error("Unexpected account trailing data");
  }
}

export function decodeProtocol(data: Uint8Array) {
  const r = new Reader(data, "ProtocolConfig", 185);
  const result = {
    authority: r.key(), protocolId: r.bytes(32), epochSeconds: r.u32(), verifier: r.key(), policyVersion: r.u32(),
    rewardMint: r.key(), rewardPerSlot: r.u64(), slotsPerEpoch: r.u8(), escrow: r.key(),
  };
  r.finish();
  return result;
}

export function decodeDevice(data: Uint8Array) {
  const r = new Reader(data, "DeviceRegistry", 126);
  const id = r.bytes(32), key = r.bytes(32), curve = r.u8(), asset = r.optional(32), linked = r.u8();
  if (linked > 1) throw new Error("Invalid Borsh boolean");
  const result = {
    deviceId: id, key, curve, externalAsset: asset === null ? null : new PublicKey(asset), linked: linked === 1,
    registeredAt: r.i64(), capabilities: r.u32(), claimedGeohash: r.optional(6)?.toString("ascii") ?? null,
  };
  r.finish();
  return result;
}

export function decodeRoot(data: Uint8Array) {
  const r = new Reader(data, "ObserverRoot", 84);
  const result = { root: r.bytes(32), leafCount: r.u32(), publishedAt: r.i64(), authority: r.key() };
  r.finish();
  return result;
}

export function decodeEnrollment(data: Uint8Array) {
  const r = new Reader(data, "EnrollmentAuthority", 176);
  const result = { authority: r.key(), publications: r.u64(), recentRoots: Array.from({ length: 4 }, () => r.bytes(32)) };
  r.finish();
  return result;
}

export function decodeDeviceEpoch(data: Uint8Array) {
  const length = data.length === 587 ? 587 : 75;
  const r = new Reader(data, "DeviceEpoch", length);
  const result = {
    independentObservers: r.u16(), paidSlotsUsed: r.u8(),
    observationRoot: r.bytes(32), confidenceCommitment: r.bytes(32),
  };
  const frontier = length === 587 ? Array.from({ length: 16 }, () => r.bytes(32)) : undefined;
  r.finish();
  return { ...result, frontier };
}

export {OBSERVATION_COMMITMENT_SIZE,DEVICE_EPOCH_SIZE,OBSERVATION_TREE_DEPTH,DEFAULT_OBSERVATION_KEY_DIGEST,
  observationAddresses,initializeObservationVerifier,submitObservation,decodeObservationVerifier,decodeObservationCommitment,
  observationTreeLeaf,observationTreeNode,appendObservationTree,verificationKeyDigest} from './observation.ts';

export function activeRoots(state: ReturnType<typeof decodeEnrollment>): Buffer[] {
  const count = Number(state.publications < 4n ? state.publications : 4n);
  return Array.from({ length: count }, (_, i) => state.recentRoots[Number((state.publications - 1n - BigInt(i)) % 4n)]!);
}
