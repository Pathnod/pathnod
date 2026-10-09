import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  confidenceAuthorizationDigest,
  publishConfidence,
} from "@pathnod/solana";
import { ObservationSigner } from "../src/observation-authorization.ts";
import { signatureBase58 } from "../src/solana-observation-relay.ts";
import {
  recoverConfidencePublication,
  writeConfidenceArtifact,
  type ConfidencePublicationJournal as Journal,
  type ConfidencePublicationState,
} from "../src/confidence-recovery.ts";

type IO = Parameters<typeof recoverConfidencePublication>[1];
const finalized = { confirmationStatus: "finalized" as const, err: null };
async function fixture(state: Journal["state"] = "prepared") {
  const directory = await mkdtemp(
      path.join(tmpdir(), "pathnod-confidence-recovery-"),
    ),
    file = path.join(directory, "publication.json");
  const vector = JSON.parse(
    await readFile(
      new URL("../../../fixtures/confidence/report-v0.json", import.meta.url),
      "utf8",
    ),
  );
  const report: Journal["report"] = vector.report,
    payer = Keypair.generate(),
    verifier = new ObservationSigner(Buffer.alloc(32, 8));
  const program = new PublicKey(report.scope.program),
    protocol = Buffer.from(report.scope.protocolID, "hex"),
    device = Buffer.from(report.scope.deviceID, "hex");
  const args = {
    epoch: report.scope.epoch,
    observationRoot: report.scope.observationRoot,
    observerCount: report.scope.transcriptOrder.length,
    previousCommitment: "00".repeat(32),
    commitment: vector.commitment,
    policyVersion: report.scope.policyVersion,
    evaluatedAtMilliseconds: BigInt(report.scope.evaluatedAtMilliseconds),
  };
  const digest = confidenceAuthorizationDigest(program, protocol, device, args);
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: new PublicKey(Buffer.alloc(32, 3)).toBase58(),
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: new PublicKey(verifier.publicKey).toBuffer(),
      message: digest,
      signature: Buffer.from(verifier.signClaimDigest(digest), "hex"),
    }),
    publishConfidence(program, protocol, device, args),
  );
  tx.sign(payer);
  const journal: Journal = {
    version: 1,
    target: "public-synthetic-test",
    report,
    commitment: vector.commitment,
    previousCommitment: args.previousCommitment,
    wire: tx.serialize().toString("base64"),
    signature: signatureBase58(tx.signature!),
    lastValidBlockHeight: 500,
    state,
  };
  const published: ConfidencePublicationState = {
    commitment: journal.commitment,
    observationRoot: report.scope.observationRoot,
    observerCount: report.scope.transcriptOrder.length,
    paidSlotsUsed: 1,
  };
  await writeConfidenceArtifact(file, journal);
  const original = await readFile(file, "utf8");
  const load = async () => JSON.parse(await readFile(file, "utf8")) as Journal;
  const send = async (wire: Buffer) => {
    assert.ok(wire.equals(Buffer.from(journal.wire, "base64")));
    const decoded = Transaction.from(wire);
    assert.ok(decoded.verifySignatures());
    assert.equal(signatureBase58(decoded.signature!), journal.signature);
    return journal.signature;
  };
  const unexpected = async (): Promise<never> => {
    throw Error("Unexpected recovery operation");
  };
  const io = (overrides: Partial<IO>): IO => ({
    inspect: unexpected,
    blockHeight: unexpected,
    send: unexpected,
    save: (j) => writeConfidenceArtifact(file, j),
    snapshot: async () => ({ ...published }),
    pause: async () => {},
    ...overrides,
  });
  const options = {
    action: "publish" as const,
    currentCommitment: journal.previousCommitment,
    paidSlotsUsed: 1,
    attempts: 3,
  };
  return {
    file,
    journal,
    published,
    original,
    load,
    send,
    io,
    options,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
test("Confidence lost broadcast response preserves the signed journal and restart retransmits identical bytes while valid", async () => {
  const f = await fixture();
  let sends = 0;
  const accepted = new Set<string>();
  try {
    await assert.rejects(
      recoverConfidencePublication(
        await f.load(),
        f.io({
          inspect: async () => null,
          blockHeight: async () => 499,
          send: async (wire) => {
            sends++;
            assert.equal((await f.load()).state, "submitted");
            accepted.add(await f.send(wire));
            throw Error("Lost broadcast response");
          },
        }),
        f.options,
      ),
      /Lost broadcast response/,
    );
    const saved = await f.load();
    assert.equal(saved.state, "submitted");
    assert.equal(saved.wire, f.journal.wire);
    assert.equal(saved.signature, f.journal.signature);
    let inspections = 0;
    await recoverConfidencePublication(
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
      f.options,
    );
    assert.equal(sends, 2);
    assert.equal(accepted.size, 1);
    assert.equal((await f.load()).state, "confirmed");
    assert.equal((await stat(f.file)).mode & 0o077, 0);
  } finally {
    await f.close();
  }
});
test("Confidence pending restart waits for successful finality without rebroadcast or checking expired block height", async () => {
  const f = await fixture("submitted");
  let inspections = 0,
    pauses = 0;
  const statuses = [
    { confirmationStatus: "processed" as const, err: null },
    { confirmationStatus: "confirmed" as const, err: null },
    finalized,
  ];
  try {
    f.journal.lastValidBlockHeight = 0;
    await writeConfidenceArtifact(f.file, f.journal);
    await recoverConfidencePublication(
      await f.load(),
      f.io({
        inspect: async () => statuses[inspections++]!,
        pause: async (ms) => {
          assert.equal(ms, 1000);
          pauses++;
        },
      }),
      f.options,
    );
    assert.equal(inspections, 3);
    assert.equal(pauses, 2);
    const saved = await f.load();
    assert.equal(saved.state, "confirmed");
    assert.equal(saved.wire, f.journal.wire);
    assert.equal(saved.signature, f.journal.signature);
  } finally {
    await f.close();
  }
});
test("Confidence finalized recovery inspects history before expiry and never rebroadcasts, including repeated recovery", async () => {
  const f = await fixture("submitted");
  let inspections = 0;
  try {
    f.journal.lastValidBlockHeight = 0;
    await writeConfidenceArtifact(f.file, f.journal);
    await recoverConfidencePublication(
      await f.load(),
      f.io({
        inspect: async () => {
          inspections++;
          return finalized;
        },
      }),
      { ...f.options, currentCommitment: f.journal.commitment },
    );
    assert.equal(inspections, 1);
    const saved = await f.load();
    assert.equal(saved.state, "confirmed");
    await recoverConfidencePublication(
      await f.load(),
      f.io({ inspect: async () => finalized }),
      { ...f.options, currentCommitment: f.journal.commitment },
    );
    assert.deepEqual(await f.load(), saved);
  } finally {
    await f.close();
  }
});
for (const state of ["prepared", "submitted"] as const) {
  test(`Confidence expired ambiguous ${state} transaction preserves its journal and never sends a replacement`, async () => {
    const f = await fixture(state);
    try {
      await assert.rejects(
        recoverConfidencePublication(
          await f.load(),
          f.io({ inspect: async () => null, blockHeight: async () => 501 }),
          f.options,
        ),
        /Expired ambiguous/,
      );
      assert.equal(await readFile(f.file, "utf8"), f.original);
    } finally {
      await f.close();
    }
  });
}
test("Confidence pending status and polling timeout cannot claim successful publication", async () => {
  const f = await fixture("submitted");
  let inspections = 0;
  try {
    const io = f.io({
      inspect: async () => {
        inspections++;
        return { confirmationStatus: "confirmed", err: null };
      },
    });
    await assert.rejects(
      recoverConfidencePublication(await f.load(), io, {
        ...f.options,
        action: "status",
      }),
      /not finalized successfully/,
    );
    assert.equal(inspections, 1);
    await assert.rejects(
      recoverConfidencePublication(await f.load(), io, {
        ...f.options,
        attempts: 2,
      }),
      /not finalized successfully/,
    );
    assert.equal(inspections, 3);
    assert.equal(await readFile(f.file, "utf8"), f.original);
  } finally {
    await f.close();
  }
});
test("Confidence finalized failure and mismatched hash/root/count/paid slots cannot mark the journal confirmed", async () => {
  const f = await fixture("submitted");
  try {
    await assert.rejects(
      recoverConfidencePublication(
        await f.load(),
        f.io({
          inspect: async () => ({
            ...finalized,
            err: { InstructionError: [2, { Custom: 6118 }] },
          }),
        }),
        f.options,
      ),
      /not finalized successfully/,
    );
    for (const changed of [
      { ...f.published, commitment: "ff".repeat(32) },
      { ...f.published, observationRoot: "ff".repeat(32) },
      { ...f.published, observerCount: 2 },
      { ...f.published, paidSlotsUsed: 2 },
    ]) {
      await assert.rejects(
        recoverConfidencePublication(
          await f.load(),
          f.io({
            inspect: async () => finalized,
            snapshot: async () => changed,
          }),
          f.options,
        ),
      );
      assert.equal(await readFile(f.file, "utf8"), f.original);
    }
  } finally {
    await f.close();
  }
});
test("Confidence changed previous hash or unavailable journal persistence stops before sending", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      recoverConfidencePublication(
        await f.load(),
        f.io({ inspect: async () => null }),
        { ...f.options, currentCommitment: "ff".repeat(32) },
      ),
      /previous hash changed/,
    );
    await assert.rejects(
      recoverConfidencePublication(
        await f.load(),
        f.io({
          inspect: async () => null,
          blockHeight: async () => 499,
          save: async () => {
            throw Error("Journal unavailable");
          },
        }),
        f.options,
      ),
      /Journal unavailable/,
    );
    assert.equal(await readFile(f.file, "utf8"), f.original);
  } finally {
    await f.close();
  }
});
test("Confidence matching chain hash without signature history does not invent a successful original transaction", async () => {
  const f = await fixture("submitted");
  try {
    await assert.rejects(
      recoverConfidencePublication(
        await f.load(),
        f.io({ inspect: async () => null }),
        { ...f.options, currentCommitment: f.journal.commitment, attempts: 1 },
      ),
      /not finalized successfully/,
    );
    assert.equal(await readFile(f.file, "utf8"), f.original);
  } finally {
    await f.close();
  }
});
