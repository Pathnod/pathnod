import assert from "node:assert/strict";
import { open, rename } from "node:fs/promises";
import {
  nullifierRejection,
  sameGate2Accounting,
  type Gate2Snapshot,
} from "./gate2-evidence.ts";

export interface Gate2ReplayJournal {
  version: 1;
  target: string;
  hash: string;
  wire: string;
  signature: string;
  lastValidBlockHeight: number;
  before: Gate2Snapshot;
  after?: Gate2Snapshot;
  state: "prepared" | "submitted" | "rejected";
}

export interface Gate2ReplayStatus {
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
  err: unknown;
}

export async function writeGate2Artifact(
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

/** The CLI validates the saved target and signed instruction bytes before invoking recovery. */
export async function recoverGate2Replay(
  journal: Gate2ReplayJournal,
  io: {
    inspect(signature: string): Promise<Gate2ReplayStatus | null>;
    blockHeight(): Promise<number>;
    send(wire: Buffer): Promise<string>;
    save(journal: Gate2ReplayJournal): Promise<void>;
    snapshot(): Promise<Gate2Snapshot>;
    pause?: (milliseconds: number) => Promise<void>;
  },
  attempts = 45,
): Promise<void> {
  assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 45);
  assert.equal(journal.version, 1);
  assert.ok(["prepared", "submitted", "rejected"].includes(journal.state));
  assert.ok(
    Number.isSafeInteger(journal.lastValidBlockHeight) &&
      journal.lastValidBlockHeight >= 0,
  );
  const pause =
    io.pause ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let status = await io.inspect(journal.signature);
  if (!status) {
    assert.ok(
      (await io.blockHeight()) <= journal.lastValidBlockHeight,
      "Expired ambiguous duplicate transaction: inspect history and journal; do not automatically replace it",
    );
    journal.state = "submitted";
    await io.save(journal);
    assert.equal(
      await io.send(Buffer.from(journal.wire, "base64")),
      journal.signature,
    );
    status = await io.inspect(journal.signature);
  }
  let rejected = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (status?.confirmationStatus === "finalized") {
      assert.ok(
        nullifierRejection(status.err),
        "Duplicate did not fail with E_NULLIFIER",
      );
      assert.equal(
        (status.err as { InstructionError: [number, unknown] })
          .InstructionError[0],
        2,
      );
      rejected = true;
      break;
    }
    if (attempt + 1 < attempts) {
      await pause(1000);
      status = await io.inspect(journal.signature);
    }
  }
  assert.ok(
    rejected,
    "Duplicate outcome remains ambiguous; resume the same journal later",
  );
  const after = await io.snapshot();
  assert.ok(
    sameGate2Accounting(journal.before, after),
    "Accounting changed during the duplicate check; inspect before declaring Gate 2 passed",
  );
  journal.after = after;
  journal.state = "rejected";
  await io.save(journal);
}
