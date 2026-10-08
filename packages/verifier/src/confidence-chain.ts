import { createHash, createPublicKey, verify } from "node:crypto";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  decodeProtocol,
  decodeDevice,
  decodeDeviceEpoch,
  decodeObservationCommitment,
  observationAddresses,
  DEVICE_EPOCH_SIZE,
} from "@pathnod/solana";
import {
  decodeObservationTranscript,
  observationTranscriptHash,
  observationEvidenceHash,
} from "./observation-transcript.ts";
import { deviceChallengeDigest } from "./observation-policy.ts";
import {
  computeConfidence,
  confidenceCommitment,
  type ConfidenceInput,
} from "./confidence.ts";

export function validateConfidenceCommitment(
  program: PublicKey,
  address: PublicKey,
  account: AccountInfo<Buffer>,
  input: ConfidenceInput,
  device: ReturnType<typeof decodeDevice>,
): void {
  if (account.executable || !account.owner.equals(program))
    throw Error("Untrusted confidence commitment owner");
  const record = decodeObservationCommitment(account.data),
    t = decodeObservationTranscript(Buffer.from(input.transcript, "base64"));
  const eq = (a: Uint8Array, b: Uint8Array) =>
    Buffer.from(a).equals(Buffer.from(b));
  const expected = observationAddresses(
    program,
    t.protocolID,
    t.deviceID,
    t.epoch,
    t.nullifier,
  ).commitment;
  if (
    !address.equals(expected) ||
    !eq(record.protocolID, t.protocolID) ||
    !eq(record.deviceID, t.deviceID) ||
    record.epoch !== t.epoch ||
    !eq(record.nullifier, t.nullifier) ||
    !eq(record.pseudonym, t.pseudonym) ||
    record.observerClass !== t.observerClass ||
    !eq(record.transcriptHash, observationTranscriptHash(t)) ||
    !eq(record.evidenceHash, t.evidenceHash) ||
    !eq(device.deviceId, t.deviceID) ||
    !eq(device.key, t.publicKey) ||
    device.curve !== t.curve ||
    t.curve !== 1 ||
    !eq(
      observationEvidenceHash(
        input.evidence === undefined
          ? undefined
          : Buffer.from(input.evidence, "base64"),
      ),
      t.evidenceHash,
    ) ||
    !eq(
      createHash("sha256")
        .update("Pathnod/device/v0")
        .update(t.publicKey)
        .digest(),
      t.deviceID,
    )
  )
    throw Error("Confidence transcript/registry binding mismatch");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      t.publicKey,
    ]),
    type: "spki",
    format: "der",
  });
  if (
    t.challenges.some(
      (c) => !verify(null, deviceChallengeDigest(t, c), key, c.signature),
    )
  )
    throw Error("Invalid confidence device signature");
}

/** The full protocol commitment set is required; missing encrypted history fails closed. */
export async function readConfidenceSnapshot(
  connection: Connection,
  program: PublicKey,
  protocol: Buffer,
  deviceID: Buffer,
  epoch: number,
  inputs: Map<string, ConfidenceInput>,
  order?: string[],
  evaluationTime = Date.now(),
) {
  const all = await connection.getProgramAccounts(program, {
    commitment: "finalized",
    withContext: true,
    filters: [
      { dataSize: 214 },
      { memcmp: { offset: 8, bytes: new PublicKey(protocol).toBase58() } },
    ],
  });
  if (all.value.length > 10000)
    throw Error("Confidence protocol history exceeds v0 limit");
  const commitments = all.value.map((row) => ({
    row,
    record: decodeObservationCommitment(row.account.data),
  }));
  const devices = [
    ...new Set(commitments.map((r) => r.record.deviceID.toString("hex"))),
  ];
  if (!devices.includes(deviceID.toString("hex")))
    throw Error("No finalized device observations");
  const addresses = observationAddresses(
    program,
    protocol,
    deviceID,
    epoch,
    Buffer.alloc(32),
  );
  const keys = [
    addresses.config,
    addresses.deviceEpoch,
    ...devices.map((id) => addresses.device(Buffer.from(id, "hex"))),
  ];
  if (keys.length > 100)
    throw Error("Confidence registry snapshot exceeds v0 batch limit");
  const state = await connection.getMultipleAccountsInfoAndContext(keys, {
    commitment: "finalized",
    minContextSlot: all.context.slot,
  });
  const trusted = (index: number) => {
    const row = state.value[index];
    if (!row || row.executable || !row.owner.equals(program))
      throw Error("Untrusted confidence registry account");
    return row.data;
  };
  const config = decodeProtocol(trusted(0)),
    deviceEpoch = decodeDeviceEpoch(trusted(1));
  if (
    !config.protocolId.equals(protocol) ||
    trusted(1).length !== DEVICE_EPOCH_SIZE
  )
    throw Error("Incompatible confidence target");
  const registered = new Map(
    devices.map((id, i) => [id, decodeDevice(trusted(i + 2))]),
  );
  const history: ConfidenceInput[] = [];
  for (const { row, record } of commitments) {
    if (!record.protocolID.equals(protocol))
      throw Error("Confidence protocol history mismatch");
    const input = inputs.get(record.transcriptHash.toString("hex"));
    if (!input)
      throw Error(
        "Missing encrypted transcript for finalized history; import authenticated historical inputs first",
      );
    validateConfidenceCommitment(
      program,
      row.pubkey,
      row.account,
      input,
      registered.get(record.deviceID.toString("hex"))!,
    );
    history.push(input);
  }
  const target = commitments.filter(
    (r) => r.record.deviceID.equals(deviceID) && r.record.epoch === epoch,
  );
  if (target.length !== deviceEpoch.independentObservers)
    throw Error("Confidence epoch changed during snapshot; retry");
  const transcriptOrder =
    order ??
    target
      .sort((a, b) => Number(a.record.submittedAt - b.record.submittedAt))
      .map((r) => r.record.transcriptHash.toString("hex"));
  const device = registered.get(deviceID.toString("hex"))!;
  const report = computeConfidence(
    {
      program: program.toBase58(),
      protocolID: protocol.toString("hex"),
      deviceID: deviceID.toString("hex"),
      epoch,
      policyVersion: config.policyVersion,
      epochSeconds: config.epochSeconds,
      evaluatedAtMilliseconds: evaluationTime,
      observationRoot: deviceEpoch.observationRoot.toString("hex"),
      transcriptOrder,
      claimedGeohash6: device.claimedGeohash,
    },
    history,
  );
  return {
    report,
    commitment: confidenceCommitment(report),
    config,
    deviceEpoch,
    addresses,
    contextSlot: state.context.slot,
  };
}
