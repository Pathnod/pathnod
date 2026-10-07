import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  BN254_MODULUS,
  bytes32,
  discriminator,
  registryAddresses,
  TOKEN_PROGRAM,
  DEVNET_USDC,
} from "./index.ts";
import { paymentAddresses } from './payments.ts';

export const OBSERVATION_COMMITMENT_SIZE = 214;
export const DEVICE_EPOCH_SIZE = 587;
export const OBSERVATION_TREE_DEPTH = 16;
export const DEFAULT_OBSERVATION_KEY_DIGEST =
  "589090366a5e7b44f436a0608b66177731775cf9e29adc223a901dd784719ffd";
export function observationAddresses(
  program: PublicKey,
  protocol: Uint8Array,
  device: Uint8Array,
  epoch: number,
  nullifier: Uint8Array,
) {
  const registry = registryAddresses(program, protocol);
  return {
    ...registry,
    commitment: PublicKey.findProgramAddressSync(
      [Buffer.from("obs"), bytes32(nullifier)],
      program,
    )[0],
    verifierInfo: PublicKey.findProgramAddressSync(
      [Buffer.from("observation-verifier")],
      program,
    )[0],
    deviceAccount: registry.device(device),
    deviceEpoch: registry.epoch(device, epoch),
  };
}
export function initializeObservationVerifier(
  program: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const addresses = observationAddresses(
    program,
    Buffer.alloc(32),
    Buffer.alloc(32),
    0,
    Buffer.alloc(32),
  );
  return new TransactionInstruction({
    programId: program,
    data: discriminator("global", "initialize_observation_verifier"),
    keys: [
      { pubkey: addresses.verifierInfo, isWritable: true, isSigner: false },
      { pubkey: addresses.enrollment, isWritable: false, isSigner: false },
      { pubkey: authority, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
  });
}
export function submitObservation(
  program: PublicKey,
  payer: PublicKey,
  protocol: Uint8Array,
  device: Uint8Array,
  transcriptHash: Uint8Array,
  evidenceHash: Uint8Array,
  proofBytes: Uint8Array,
  mint: PublicKey = DEVNET_USDC,
): TransactionInstruction {
  const proof = Buffer.from(proofBytes);
  if (proof.length !== 480)
    throw Error("Expected the seven-input 480-byte proof");
  for (let offset = 256; offset < 480; offset += 32)
    if (
      BigInt("0x" + proof.subarray(offset, offset + 32).toString("hex")) >=
      BN254_MODULUS
    )
      throw Error("Noncanonical public input");
  if (
    proof.subarray(352, 380).some((b) => b !== 0) ||
    proof.subarray(448, 479).some((b) => b !== 0) ||
    ![1, 2, 3].includes(proof[479]!)
  )
    throw Error("Invalid epoch/class");
  const addresses = observationAddresses(
    program,
    protocol,
    device,
    proof.readUInt32BE(380),
    proof.subarray(384, 416),
  );
  const root = addresses.root(proof.subarray(256, 288));
  const payments = paymentAddresses(program, protocol, proof.subarray(416,448));
  return new TransactionInstruction({
    programId: program,
    data: Buffer.concat([
      discriminator("global", "submit_observation"),
      proof,
      bytes32(transcriptHash),
      bytes32(evidenceHash),
    ]),
    keys: [
      { pubkey: addresses.config, isWritable: false, isSigner: false },
      { pubkey: addresses.deviceAccount, isWritable: false, isSigner: false },
      { pubkey: addresses.enrollment, isWritable: false, isSigner: false },
      { pubkey: root, isWritable: false, isSigner: false },
      { pubkey: addresses.commitment, isWritable: true, isSigner: false },
      { pubkey: addresses.deviceEpoch, isWritable: true, isSigner: false },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isWritable: false,
        isSigner: false,
      },
      { pubkey: payer, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
      { pubkey: payments.settings, isWritable: false, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: addresses.escrow, isWritable: true, isSigner: false },
      { pubkey: payments.payout, isWritable: true, isSigner: false },
      { pubkey: payments.vault, isWritable: true, isSigner: false },
      { pubkey: payments.feeVault, isWritable: true, isSigner: false },
      { pubkey: TOKEN_PROGRAM, isWritable: false, isSigner: false },
    ],
  });
}
export function decodeObservationVerifier(data: Uint8Array) {
  const bytes = Buffer.from(data);
  if (
    bytes.length !== 42 ||
    !bytes
      .subarray(0, 8)
      .equals(discriminator("account", "ObservationVerifierInfo")) ||
    bytes[40] !== 2 ||
    bytes[41] !== 7
  )
    throw Error("Invalid observation verifier metadata");
  return {
    keyDigest: bytes.subarray(8, 40).toString("hex"),
    abiVersion: 2,
    publicInputs: 7,
  };
}
export function decodeObservationCommitment(data: Uint8Array) {
  const bytes = Buffer.from(data);
  if (
    bytes.length !== OBSERVATION_COMMITMENT_SIZE ||
    !bytes
      .subarray(0, 8)
      .equals(discriminator("account", "ObservationCommitment"))
  )
    throw Error("Invalid observation commitment");
  const result = {
    protocolID: bytes.subarray(8, 40),
    deviceID: bytes.subarray(40, 72),
    epoch: bytes.readUInt32LE(72),
    nullifier: bytes.subarray(76, 108),
    pseudonym: bytes.subarray(108, 140),
    observerClass: bytes[140]!,
    transcriptHash: bytes.subarray(141, 173),
    evidenceHash: bytes.subarray(173, 205),
    slotPaid: bytes[205] === 1,
    submittedAt: bytes.readBigInt64LE(206),
  };
  if (
    ![1, 2, 3].includes(result.observerClass) ||
    bytes[205]! > 1 ||
    result.submittedAt <= 0n ||
    [result.nullifier, result.pseudonym].some(
      (v) => BigInt("0x" + v.toString("hex")) >= BN254_MODULUS,
    )
  )
    throw Error("Invalid observation commitment fields");
  return result;
}
export function observationTreeLeaf(transcriptHash: Uint8Array) {
  return createHash("sha256")
    .update("Pathnod/observation-leaf/v0")
    .update(bytes32(transcriptHash))
    .digest();
}
export function observationTreeNode(left: Uint8Array, right: Uint8Array) {
  return createHash("sha256")
    .update("Pathnod/observation-node/v0")
    .update(bytes32(left))
    .update(bytes32(right))
    .digest();
}
export function appendObservationTree(
  frontier: Uint8Array[],
  count: number,
  transcriptHash: Uint8Array,
) {
  if (
    frontier.length !== 16 ||
    !Number.isInteger(count) ||
    count < 0 ||
    count >= 65535
  )
    throw Error("Invalid observation frontier/count");
  const next = frontier.map(bytes32);
  let node = observationTreeLeaf(transcriptHash),
    zero = createHash("sha256").update("Pathnod/observation-empty/v0").digest();
  for (let level = 0; level < 16; level++) {
    if ((count & (1 << level)) === 0) {
      next[level] = node;
      node = observationTreeNode(node, zero);
    } else node = observationTreeNode(next[level]!, node);
    zero = observationTreeNode(zero, zero);
  }
  return { frontier: next, root: node, count: count + 1 };
}
export function verificationKeyDigest(value: unknown): string {
  const key = value as {
    protocol?: string;
    curve?: string;
    nPublic?: number;
    vk_alpha_1?: unknown;
    vk_beta_2?: unknown;
    vk_gamma_2?: unknown;
    vk_delta_2?: unknown;
    IC?: unknown;
  };
  const fq =
    21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const array = (v: unknown, n: number): unknown[] => {
    if (!Array.isArray(v) || v.length !== n)
      throw Error("Invalid verification key");
    return v;
  };
  const scalar = (v: unknown) => {
    if (
      typeof v !== "string" ||
      v.length > 77 ||
      !/^(0|[1-9][0-9]*)$/.test(v) ||
      BigInt(v) >= fq
    )
      throw Error("Invalid verification key coordinate");
    return Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
  };
  const g1 = (v: unknown) => {
    const [x, y, z] = array(v, 3);
    if (z !== "1") throw Error("Invalid affine G1");
    return Buffer.concat([scalar(x), scalar(y)]);
  };
  const g2 = (v: unknown) => {
    const [x, y, z] = array(v, 3);
    if (JSON.stringify(z) !== '["1","0"]') throw Error("Invalid affine G2");
    const [x0, x1] = array(x, 2),
      [y0, y1] = array(y, 2);
    return Buffer.concat([scalar(x1), scalar(x0), scalar(y1), scalar(y0)]);
  };
  if (
    !key ||
    key.protocol !== "groth16" ||
    key.curve !== "bn128" ||
    key.nPublic !== 7
  )
    throw Error("Invalid observation key");
  return createHash("sha256")
    .update("Pathnod/groth16-key/v0")
    .update(
      Buffer.concat([
        g1(key.vk_alpha_1),
        g2(key.vk_beta_2),
        g2(key.vk_gamma_2),
        g2(key.vk_delta_2),
        ...array(key.IC, 8).map(g1),
      ]),
    )
    .digest("hex");
}
