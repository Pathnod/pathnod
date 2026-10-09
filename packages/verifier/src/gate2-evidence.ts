import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  TOKEN_PROGRAM,
  DEVNET_USDC,
  decodePayout,
  decodeProtocol,
  decodeDeviceEpoch,
  decodeObservationCommitment,
  observationAddresses,
  paymentAddresses,
  appendObservationTree,
  decodePaymentSettings,
} from "@pathnod/solana";
import type { ObservationRelayPayload } from "./observation-relay.ts";

export interface Gate2Snapshot {
  commitment: string;
  independentObservers: number;
  paidSlotsUsed: number;
  observationRoot: string;
  slotPaid: boolean;
  gross: string;
  fees: string;
  available: string;
  withdrawn: string;
  payoutNonce: string;
  escrow: string;
  feeVault: string;
  payoutVault: string;
}

export async function observationAccountingSnapshot(
  connection: { getMultipleAccountsInfo(keys: PublicKey[], commitment: "finalized"): Promise<(AccountInfo<Buffer> | null)[]> },
  program: PublicKey,
  payload: ObservationRelayPayload,
): Promise<Gate2Snapshot> {
  const protocol = Buffer.from(payload.protocolID, "hex"),
    device = Buffer.from(payload.deviceID, "hex");
  const addresses = observationAddresses(
    program,
    protocol,
    device,
    payload.epoch,
    Buffer.from(payload.nullifier, "hex"),
  );
  const payments = paymentAddresses(
    program,
    protocol,
    Buffer.from(payload.pseudonym, "hex"),
  );
  const rows = await connection.getMultipleAccountsInfo(
    [
      addresses.config,
      addresses.commitment,
      addresses.deviceEpoch,
      payments.payout,
      addresses.escrow,
      payments.feeVault,
      payments.vault,
      payments.settings,
    ],
    "finalized",
  );
  if (rows.length !== 8) throw Error("Incomplete Gate 2 snapshot");
  const trusted = (
    row: AccountInfo<Buffer> | null | undefined,
    owner: PublicKey,
  ) => {
    if (!row || row.executable || !row.owner.equals(owner))
      throw Error("Untrusted Gate 2 account");
    return row.data;
  };
  const config = decodeProtocol(trusted(rows[0], program));
  const settings = decodePaymentSettings(trusted(rows[7], program));
  if (!settings.mint.equals(DEVNET_USDC) || settings.feeBps !== 2000)
    throw Error("Gate 2 payment policy mismatch");
  if (
    !config.protocolId.equals(protocol) ||
    !config.rewardMint.equals(DEVNET_USDC) ||
    !config.escrow.equals(addresses.escrow)
  )
    throw Error("Gate 2 protocol binding mismatch");
  const record = decodeObservationCommitment(trusted(rows[1], program));
  if (
    !record.protocolID.equals(protocol) ||
    !record.deviceID.equals(device) ||
    record.epoch !== payload.epoch ||
    record.transcriptHash.toString("hex") !== payload.transcriptHash ||
    record.evidenceHash.toString("hex") !== payload.evidenceHash ||
    record.nullifier.toString("hex") !== payload.nullifier ||
    record.pseudonym.toString("hex") !== payload.pseudonym ||
    record.observerClass !== 1 ||
    payload.observerClass !== 1
  )
    throw Error("Gate 2 requires the matching iOS observation");
  const epoch = decodeDeviceEpoch(trusted(rows[2], program));
  const payout = decodePayout(trusted(rows[3], program));
  if (
    !payout.protocol.equals(protocol) ||
    payout.pseudonym.toString("hex") !== payload.pseudonym ||
    !payout.mint.equals(DEVNET_USDC)
  )
    throw Error("Gate 2 payout binding mismatch");
  if (
    epoch.independentObservers < 1 ||
    epoch.paidSlotsUsed < 1 || epoch.paidSlotsUsed > epoch.independentObservers ||
    !record.slotPaid
  )
    throw Error("Replay requires an existing paid observation");
  const token = (
    row: AccountInfo<Buffer> | null | undefined,
    authority: PublicKey,
  ) => {
    const bytes = trusted(row, TOKEN_PROGRAM);
    if (
      bytes.length !== 165 ||
      bytes[108] !== 1 ||
      !bytes.subarray(0, 32).equals(DEVNET_USDC.toBuffer()) ||
      !bytes.subarray(32, 64).equals(authority.toBuffer())
    )
      throw Error("Gate 2 token binding mismatch");
    return String(bytes.readBigUInt64LE(64));
  };
  return {
    commitment: addresses.commitment.toBase58(),
    independentObservers: epoch.independentObservers,
    paidSlotsUsed: epoch.paidSlotsUsed,
    observationRoot: epoch.observationRoot.toString("hex"),
    slotPaid: record.slotPaid,
    gross: String(payout.gross),
    fees: String(payout.fees),
    available: String(payout.available),
    withdrawn: String(payout.withdrawn),
    payoutNonce: String(payout.nonce),
    escrow: token(rows[4], addresses.config),
    feeVault: token(rows[5], settings.treasury),
    payoutVault: token(rows[6], payments.payout),
  };
}

export async function gate2Snapshot(
  connection: Parameters<typeof observationAccountingSnapshot>[0],
  program: PublicKey,
  payload: ObservationRelayPayload,
): Promise<Gate2Snapshot> {
  const snapshot = await observationAccountingSnapshot(connection, program, payload);
  if (snapshot.independentObservers !== 1 || snapshot.paidSlotsUsed !== 1)
    throw Error("Gate 2 requires one paid independent observation");
  const expected = appendObservationTree(Array.from({ length: 16 }, () => Buffer.alloc(32)),
    0, Buffer.from(payload.transcriptHash, "hex")).root;
  if (snapshot.observationRoot !== expected.toString("hex")) throw Error("Gate 2 commitment tree mismatch");
  return snapshot;
}

export function sameGate2Accounting(
  before: Gate2Snapshot,
  after: Gate2Snapshot,
): boolean {
  const keys = Object.keys(before) as (keyof Gate2Snapshot)[];
  return keys.length === Object.keys(after).length && keys.every(
    key => Object.hasOwn(after, key) && before[key] === after[key],
  );
}

export function nullifierRejection(error: unknown): boolean {
  const value = error as {
    InstructionError?: [number, { Custom?: number }];
  } | null;
  return (
    Array.isArray(value?.InstructionError) &&
    value.InstructionError[1]?.Custom === 6001
  );
}
