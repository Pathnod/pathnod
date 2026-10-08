import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ObservationSigner } from "../src/observation-authorization.ts";
import { signatureBase58 } from "../src/solana-observation-relay.ts";
import {
  recoverGate2Replay,
  writeGate2Artifact,
  type Gate2ReplayJournal,
  type Gate2ReplayStatus,
} from "../src/gate2-recovery.ts";
import type { Gate2Snapshot } from "../src/gate2-evidence.ts";

const finalized: Gate2ReplayStatus = {
  confirmationStatus: "finalized",
  err: { InstructionError: [2, { Custom: 6001 }] },
};
type IO = Parameters<typeof recoverGate2Replay>[1];

async function fixture(state: Gate2ReplayJournal["state"] = "prepared") {
  const directory = await mkdtemp(
      path.join(tmpdir(), "pathnod-gate2-recovery-"),
    ),
    file = path.join(directory, "duplicate.json");
  const payer = Keypair.generate(),
    verifier = new ObservationSigner(Buffer.alloc(32, 8));
  const digest = createHash("sha256")
    .update("public synthetic Gate 2 recovery fixture")
    .digest();
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 299999 }),
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: new PublicKey(verifier.publicKey).toBuffer(),
      message: digest,
      signature: Buffer.from(verifier.signClaimDigest(digest), "hex"),
    }),
    new TransactionInstruction({
      programId: new PublicKey(Buffer.alloc(32, 4)),
      keys: [],
      data: Buffer.from("public synthetic submit fixture"),
    }),
  ];
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: new PublicKey(Buffer.alloc(32, 3)).toBase58(),
      instructions,
    }).compileToV0Message(),
  );
  tx.sign([payer]);
  const before: Gate2Snapshot = {
    commitment: new PublicKey(Buffer.alloc(32, 5)).toBase58(),
    independentObservers: 1,
    paidSlotsUsed: 1,
    observationRoot: "11".repeat(32),
    slotPaid: true,
    gross: "50000",
    fees: "10000",
    available: "40000",
    withdrawn: "0",
    payoutNonce: "0",
    escrow: "100000",
    feeVault: "10000",
    payoutVault: "40000",
  };
  const journal: Gate2ReplayJournal = {
    version: 1,
    target: "public-synthetic-test",
    hash: "22".repeat(32),
    wire: Buffer.from(tx.serialize()).toString("base64"),
    signature: signatureBase58(tx.signatures[0]!),
    lastValidBlockHeight: 500,
    before,
    state,
  };
  await writeGate2Artifact(file, journal);
  const original = await readFile(file, "utf8");
  const load = async () =>
    JSON.parse(await readFile(file, "utf8")) as Gate2ReplayJournal;
  const send = async (wire: Buffer) => {
    assert.ok(
      wire.equals(Buffer.from(journal.wire, "base64")),
      "Recovery must reuse the exact signed bytes",
    );
    const decoded = VersionedTransaction.deserialize(wire);
    assert.equal(signatureBase58(decoded.signatures[0]!), journal.signature);
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        payer.publicKey.toBuffer(),
      ]),
      format: "der",
      type: "spki",
    });
    assert.ok(
      verify(null, decoded.message.serialize(), key, decoded.signatures[0]!),
    );
    return journal.signature;
  };
  const unexpected = async (): Promise<never> => {
    throw Error("Unexpected recovery operation");
  };
  const io = (overrides: Partial<IO>): IO => ({
    inspect: unexpected,
    blockHeight: unexpected,
    send: unexpected,
    save: (j) => writeGate2Artifact(file, j),
    snapshot: async () => structuredClone(before),
    pause: async () => {},
    ...overrides,
  });
  return {
    file,
    journal,
    before,
    original,
    load,
    send,
    io,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("Gate 2 lost broadcast response survives restart and retransmits only the identical transaction while valid", async () => {
  const f = await fixture();
  let sends = 0;
  const accepted = new Set<string>();
  try {
    await assert.rejects(
      recoverGate2Replay(
        await f.load(),
        f.io({
          inspect: async () => null,
          blockHeight: async () => 499,
          send: async (wire) => {
            sends++;
            const saved = await f.load();
            assert.equal(saved.state, "submitted");
            assert.equal(saved.wire, f.journal.wire);
            const signature = await f.send(wire);
            accepted.add(signature);
            throw Error("Lost broadcast response");
          },
        }),
      ),
      /Lost broadcast response/,
    );
    const saved = await f.load();
    assert.equal(saved.state, "submitted");
    assert.equal(saved.signature, f.journal.signature);
    assert.equal(saved.after, undefined);
    let inspections = 0;
    await recoverGate2Replay(
      await f.load(),
      f.io({
        inspect: async (signature) => {
          assert.equal(signature, f.journal.signature);
          return ++inspections === 1 ? null : finalized;
        },
        blockHeight: async () => 499,
        send: async (wire) => {
          sends++;
          const signature = await f.send(wire);
          accepted.add(signature);
          return signature;
        },
      }),
    );
    assert.equal(sends, 2);
    assert.equal(accepted.size, 1);
    assert.equal((await f.load()).state, "rejected");
    assert.deepEqual((await f.load()).after, f.before);
    assert.equal((await stat(f.file)).mode & 0o077, 0);
  } finally {
    await f.close();
  }
});

test("Gate 2 restart with a pending transaction waits for finality without broadcast or expiry replacement", async () => {
  const f = await fixture("submitted");
  let inspections = 0,
    pauses = 0;
  const statuses: Gate2ReplayStatus[] = [
    { confirmationStatus: "processed", err: null },
    { confirmationStatus: "confirmed", err: finalized.err },
    finalized,
  ];
  try {
    await recoverGate2Replay(
      await f.load(),
      f.io({
        inspect: async () => statuses[inspections++]!,
        pause: async (ms) => {
          assert.equal(ms, 1000);
          pauses++;
        },
      }),
      3,
    );
    assert.equal(inspections, 3);
    assert.equal(pauses, 2);
    const saved = await f.load();
    assert.equal(saved.state, "rejected");
    assert.equal(saved.wire, f.journal.wire);
    assert.equal(saved.signature, f.journal.signature);
    assert.deepEqual(saved.after, f.before);
  } finally {
    await f.close();
  }
});

test("Gate 2 finalized E_NULLIFIER recovery checks history first and never rebroadcasts an expired transaction", async () => {
  const f = await fixture("submitted");
  let inspections = 0;
  try {
    f.journal.lastValidBlockHeight = 0;
    await writeGate2Artifact(f.file, f.journal);
    await recoverGate2Replay(
      await f.load(),
      f.io({
        inspect: async () => {
          inspections++;
          return finalized;
        },
      }),
    );
    assert.equal(inspections, 1);
    const saved = await f.load();
    assert.equal(saved.state, "rejected");
    assert.deepEqual(saved.after, f.before);
    await recoverGate2Replay(
      await f.load(),
      f.io({ inspect: async () => finalized }),
    );
    assert.deepEqual(await f.load(), saved);
  } finally {
    await f.close();
  }
});

for (const state of ["prepared", "submitted"] as const) {
  test(`Gate 2 expired ambiguous ${state} transaction stops without changing its journal or sending`, async () => {
    const f = await fixture(state);
    try {
      await assert.rejects(
        recoverGate2Replay(
          await f.load(),
          f.io({ inspect: async () => null, blockHeight: async () => 501 }),
        ),
        /Expired ambiguous/,
      );
      assert.equal(await readFile(f.file, "utf8"), f.original);
    } finally {
      await f.close();
    }
  });
}

test("Gate 2 pending polling timeout preserves the recoverable journal and cannot claim a rejection", async () => {
  const f = await fixture("submitted");
  let inspections = 0;
  try {
    await assert.rejects(
      recoverGate2Replay(
        await f.load(),
        f.io({
          inspect: async () => {
            inspections++;
            return { confirmationStatus: "confirmed", err: finalized.err };
          },
        }),
        2,
      ),
      /remains ambiguous/,
    );
    assert.equal(inspections, 2);
    assert.equal(await readFile(f.file, "utf8"), f.original);
  } finally {
    await f.close();
  }
});

for (const [name, err] of [
  ["successful transaction", null],
  ["another program error", { InstructionError: [2, { Custom: 6002 }] }],
  [
    "nullifier error at another instruction",
    { InstructionError: [0, { Custom: 6001 }] },
  ],
] as const) {
  test(`Gate 2 finalized ${name} cannot be recorded as the expected rejection`, async () => {
    const f = await fixture("submitted");
    try {
      await assert.rejects(
        recoverGate2Replay(
          await f.load(),
          f.io({
            inspect: async () => ({ confirmationStatus: "finalized", err }),
          }),
        ),
      );
      assert.equal(await readFile(f.file, "utf8"), f.original);
    } finally {
      await f.close();
    }
  });
}

test("Gate 2 changed accounting or an incomplete baseline cannot produce a successful recovery journal", async () => {
  const f = await fixture("submitted");
  try {
    await assert.rejects(
      recoverGate2Replay(
        await f.load(),
        f.io({
          inspect: async () => finalized,
          snapshot: async () => ({ ...f.before, payoutVault: "80000" }),
        }),
      ),
      /Accounting changed/,
    );
    assert.equal(await readFile(f.file, "utf8"), f.original);
    const incomplete = await f.load();
    delete (incomplete.before as Partial<Gate2Snapshot>).payoutVault;
    await writeGate2Artifact(f.file, incomplete);
    const saved = await readFile(f.file, "utf8");
    await assert.rejects(
      recoverGate2Replay(
        await f.load(),
        f.io({ inspect: async () => finalized }),
      ),
      /Accounting changed/,
    );
    assert.equal(await readFile(f.file, "utf8"), saved);
  } finally {
    await f.close();
  }
});

test("Gate 2 persistence failure before broadcast sends nothing and retains the prepared signed transaction", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      recoverGate2Replay(
        await f.load(),
        f.io({
          inspect: async () => null,
          blockHeight: async () => 499,
          save: async () => {
            throw Error("Journal unavailable");
          },
        }),
      ),
      /Journal unavailable/,
    );
    assert.equal(await readFile(f.file, "utf8"), f.original);
  } finally {
    await f.close();
  }
});
