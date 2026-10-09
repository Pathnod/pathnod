import assert from "node:assert/strict";
import { open, rename } from "node:fs/promises";
import type { computeConfidence } from "./confidence.ts";

export interface ConfidencePublicationJournal {
  version: 1;
  target: string;
  report: ReturnType<typeof computeConfidence>;
  commitment: string;
  previousCommitment: string;
  signature: string;
  wire: string;
  lastValidBlockHeight: number;
  state: "prepared" | "submitted" | "confirmed";
}

export interface ConfidencePublicationState {
  commitment: string;
  observationRoot: string;
  observerCount: number;
  paidSlotsUsed: number;
}

export async function writeConfidenceArtifact(
  file: string,
  value: unknown,
): Promise<void> {
  const handle = await open(file + ".next", "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(file + ".next", file);
}

/** The CLI checks the target, report hash and signed instructions before recovery. */
export async function recoverConfidencePublication(
  journal: ConfidencePublicationJournal,
  io: {
    inspect(
      signature: string,
    ): Promise<{
      confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
      err: unknown;
    } | null>;
    blockHeight(): Promise<number>;
    send(wire: Buffer): Promise<string>;
    save(journal: ConfidencePublicationJournal): Promise<void>;
    snapshot(): Promise<ConfidencePublicationState>;
    pause?: (milliseconds: number) => Promise<void>;
  },
  options: {
    action: "publish" | "status" | "report";
    currentCommitment: string;
    paidSlotsUsed: number;
    attempts?: number;
  },
): Promise<void> {
  const attempts = options.action === "status" ? 1 : (options.attempts ?? 45);
  assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 45);
  assert.equal(journal.version, 1);
  assert.ok(["prepared", "submitted", "confirmed"].includes(journal.state));
  assert.ok(
    Number.isSafeInteger(journal.lastValidBlockHeight) &&
      journal.lastValidBlockHeight >= 0,
  );
  const pause =
    io.pause ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await io.inspect(journal.signature);
  if (!result && options.currentCommitment !== journal.commitment) {
    assert.equal(
      options.action,
      "publish",
      "Publication not yet found; resume with publish",
    );
    assert.equal(
      options.currentCommitment,
      journal.previousCommitment,
      "Publication previous hash changed",
    );
    assert.ok(
      (await io.blockHeight()) <= journal.lastValidBlockHeight,
      "Expired ambiguous publication: inspect history; do not automatically replace the transaction",
    );
    journal.state = "submitted";
    await io.save(journal);
    assert.equal(
      await io.send(Buffer.from(journal.wire, "base64")),
      journal.signature,
    );
    result = await io.inspect(journal.signature);
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (result?.confirmationStatus === "finalized") break;
    if (attempt + 1 < attempts) {
      await pause(1000);
      result = await io.inspect(journal.signature);
    }
  }
  assert.ok(
    result?.confirmationStatus === "finalized" && result.err === null,
    "Confidence transaction is not finalized successfully; preserve and reconcile the journal",
  );
  const state = await io.snapshot(),
    scope = journal.report.scope;
  assert.equal(
    state.commitment,
    journal.commitment,
    "Finalized confidence hash mismatch",
  );
  assert.equal(
    state.observationRoot,
    scope.observationRoot,
    "Finalized confidence observation root mismatch",
  );
  assert.equal(
    state.observerCount,
    scope.transcriptOrder.length,
    "Finalized confidence observer count mismatch",
  );
  assert.equal(
    state.paidSlotsUsed,
    options.paidSlotsUsed,
    "Finalized confidence paid-slot count changed",
  );
  journal.state = "confirmed";
  await io.save(journal);
}
