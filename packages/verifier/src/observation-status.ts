import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  decodeDeviceEpoch,
  decodeObservationCommitment,
  observationAddresses,
} from "@pathnod/solana";
import type { ObservationRelayPayload } from "./observation-relay.ts";

export interface ObservationChainStatus {
  network: "devnet" | "local-validator";
  on_chain: boolean;
  program: string;
  protocol_id: string;
  device_id: string;
  epoch: number;
  paid: boolean | null;
  independent_observers: number | null;
  paid_slots_used: number | null;
  observation_root: string | null;
}

export async function finalizedObservationStatus(
  reader: {
    read(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
  },
  program: PublicKey,
  protocol: Buffer,
  payload: ObservationRelayPayload,
  network: ObservationChainStatus["network"],
): Promise<ObservationChainStatus> {
  if (payload.protocolID !== protocol.toString("hex"))
    throw Error("Observation status target mismatch");
  const addresses = observationAddresses(
    program,
    protocol,
    Buffer.from(payload.deviceID, "hex"),
    payload.epoch,
    Buffer.from(payload.nullifier, "hex"),
  );
  const rows = await reader.read([addresses.commitment, addresses.deviceEpoch]);
  if (rows.length !== 2) throw Error("Incomplete observation status snapshot");
  const base = {
    network,
    program: program.toBase58(),
    protocol_id: payload.protocolID,
    device_id: payload.deviceID,
    epoch: payload.epoch,
  };
  if (rows[0] === null)
    return {
      ...base,
      on_chain: false,
      paid: null,
      independent_observers: null,
      paid_slots_used: null,
      observation_root: null,
    };
  const trusted = (row: AccountInfo<Buffer> | null | undefined) => {
    if (!row || row.executable || !row.owner.equals(program))
      throw Error("Untrusted observation status account");
    return row.data;
  };
  const record = decodeObservationCommitment(trusted(rows[0]));
  if (
    record.protocolID.toString("hex") !== payload.protocolID ||
    record.deviceID.toString("hex") !== payload.deviceID ||
    record.epoch !== payload.epoch ||
    record.nullifier.toString("hex") !== payload.nullifier ||
    record.pseudonym.toString("hex") !== payload.pseudonym ||
    record.observerClass !== payload.observerClass ||
    record.transcriptHash.toString("hex") !== payload.transcriptHash ||
    record.evidenceHash.toString("hex") !== payload.evidenceHash
  ) {
    throw Error("Mismatched finalized observation");
  }
  const epoch = decodeDeviceEpoch(trusted(rows[1]));
  if (
    epoch.independentObservers < 1 ||
    epoch.paidSlotsUsed > epoch.independentObservers ||
    (record.slotPaid && epoch.paidSlotsUsed < 1)
  )
    throw Error("Invalid finalized epoch accounting");
  return {
    ...base,
    on_chain: true,
    paid: record.slotPaid,
    independent_observers: epoch.independentObservers,
    paid_slots_used: epoch.paidSlotsUsed,
    observation_root: epoch.observationRoot.toString("hex"),
  };
}
