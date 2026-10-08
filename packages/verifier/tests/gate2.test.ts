import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  discriminator,
  DEVNET_USDC,
  TOKEN_PROGRAM,
  observationAddresses,
  paymentAddresses,
  appendObservationTree,
} from "@pathnod/solana";
import { finalizedObservationStatus } from "../src/observation-status.ts";
import {
  gate2Snapshot,
  sameGate2Accounting,
  nullifierRejection,
} from "../src/gate2-evidence.ts";
import type { ObservationRelayPayload } from "../src/observation-relay.ts";

function fixture() {
  const program = new PublicKey("5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd");
  const vector = JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/observations/transcript-v0.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).vectors[0].transcript;
  const payload: ObservationRelayPayload = {
    protocolID: vector.protocolID.slice(2),
    deviceID: vector.deviceID.slice(2),
    epoch: 42,
    transcriptHash: "11".repeat(32),
    evidenceHash: "00".repeat(32),
    nullifier: vector.nullifier.slice(2),
    pseudonym: vector.pseudonym.slice(2),
    observerClass: 1,
    policyVersion: 1,
    proofBytes: "",
    verifier: program.toBase58(),
    verifierSignature: "",
  };
  const protocol = Buffer.from(payload.protocolID, "hex"),
    a = observationAddresses(
      program,
      protocol,
      Buffer.from(payload.deviceID, "hex"),
      42,
      Buffer.from(payload.nullifier, "hex"),
    ),
    p = paymentAddresses(
      program,
      protocol,
      Buffer.from(payload.pseudonym, "hex"),
    );
  const record = Buffer.alloc(214);
  discriminator("account", "ObservationCommitment").copy(record);
  protocol.copy(record, 8);
  Buffer.from(payload.deviceID, "hex").copy(record, 40);
  record.writeUInt32LE(42, 72);
  Buffer.from(payload.nullifier, "hex").copy(record, 76);
  Buffer.from(payload.pseudonym, "hex").copy(record, 108);
  record[140] = 1;
  Buffer.from(payload.transcriptHash, "hex").copy(record, 141);
  record[205] = 1;
  record.writeBigInt64LE(1n, 206);
  const epoch = Buffer.alloc(587);
  discriminator("account", "DeviceEpoch").copy(epoch);
  epoch.writeUInt16LE(1, 8);
  epoch[10] = 1;
  appendObservationTree(
    Array.from({ length: 16 }, () => Buffer.alloc(32)),
    0,
    Buffer.from(payload.transcriptHash, "hex"),
  ).root.copy(epoch, 11);
  const config = Buffer.alloc(185);
  discriminator("account", "ProtocolConfig").copy(config);
  program.toBuffer().copy(config, 8);
  protocol.copy(config, 40);
  config.writeUInt32LE(604800, 72);
  program.toBuffer().copy(config, 76);
  config.writeUInt32LE(1, 108);
  DEVNET_USDC.toBuffer().copy(config, 112);
  config.writeBigUInt64LE(50000n, 144);
  config[152] = 3;
  a.escrow.toBuffer().copy(config, 153);
  const payout = Buffer.alloc(176);
  discriminator("account", "Payout").copy(payout);
  protocol.copy(payout, 8);
  Buffer.from(payload.pseudonym, "hex").copy(payout, 40);
  DEVNET_USDC.toBuffer().copy(payout, 72);
  payout.writeBigUInt64LE(50000n, 136);
  payout.writeBigUInt64LE(10000n, 144);
  payout.writeBigUInt64LE(40000n, 152);
  const settings = Buffer.alloc(106);
  discriminator("account", "PaymentSettings").copy(settings);
  program.toBuffer().copy(settings, 8);
  DEVNET_USDC.toBuffer().copy(settings, 40);
  program.toBuffer().copy(settings, 72);
  settings.writeUInt16LE(2000, 104);
  const owned = (data: Buffer, owner = program): AccountInfo<Buffer> => ({
    data,
    owner,
    executable: false,
    lamports: 1,
  });
  const token = (amount: bigint, authority: PublicKey) => {
    const data = Buffer.alloc(165);
    DEVNET_USDC.toBuffer().copy(data);
    authority.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return owned(data, TOKEN_PROGRAM);
  };
  const rows: (AccountInfo<Buffer> | null)[] = [
    owned(config),
    owned(record),
    owned(epoch),
    owned(payout),
    token(100000n, a.config),
    token(10000n, program),
    token(40000n, p.payout),
    owned(settings),
  ];
  return {
    program,
    protocol,
    payload,
    record,
    epoch,
    rows,
    reader: { read: async () => [rows[1]!, rows[2]!] },
    connection: {
      getMultipleAccountsInfo: async (
        _keys: PublicKey[],
        commitment?: string,
      ) => {
        assert.equal(commitment, "finalized");
        return rows;
      },
    },
  };
}
test("DEV-38 confirms the exact finalized commitment and never converts a policy receipt into chain/payment success", async () => {
  const f = fixture();
  let result = await finalizedObservationStatus(
    f.reader,
    f.program,
    f.protocol,
    f.payload,
    "devnet",
  );
  assert.equal(result.on_chain, true);
  assert.equal(result.paid, true);
  f.rows[1] = null;
  result = await finalizedObservationStatus(
    f.reader,
    f.program,
    f.protocol,
    f.payload,
    "devnet",
  );
  assert.equal(result.on_chain, false);
  assert.equal(result.paid, null);
  assert.equal(result.independent_observers, null);
});
test("DEV-38 status fails closed on an unrelated commitment, invalid owner and impossible epoch accounting", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.record[141] = 12;
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows[1]!.owner = PublicKey.default;
    },
    (f: ReturnType<typeof fixture>) => {
      f.epoch[10] = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.rows[2] = null;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      finalizedObservationStatus(
        f.reader,
        f.program,
        f.protocol,
        f.payload,
        "devnet",
      ),
    );
  }
});
test("DEV-38 reads paid accounting in one finalized bank and detects changes after a replay", async () => {
  const f = fixture(),
    before = await gate2Snapshot(f.connection, f.program, f.payload);
  assert.equal(before.gross, "50000");
  assert.equal(before.fees, "10000");
  assert.equal(before.escrow, "100000");
  assert.equal(before.payoutVault, "40000");
  assert.ok(sameGate2Accounting(before, { ...before }));
  assert.ok(!sameGate2Accounting(before, { ...before, gross: "100000" }));
  assert.ok(
    !sameGate2Accounting(before, { ...before, independentObservers: 2 }),
  );
  f.rows[6]!.data[32] = 0;
  await assert.rejects(
    gate2Snapshot(f.connection, f.program, f.payload),
    /token binding/,
  );
});
test("DEV-38 does not accept another failure as a nullifier rejection", () => {
  assert.ok(nullifierRejection({ InstructionError: [2, { Custom: 6001 }] }));
  assert.ok(!nullifierRejection(null));
  assert.ok(!nullifierRejection({ InstructionError: [2, { Custom: 6000 }] }));
  assert.ok(!nullifierRejection("BlockhashNotFound"));
});
