import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  open,
  unlink,
  stat,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  MessageV0,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  DEVNET_GENESIS,
  externalFile,
  privateFile,
  digest,
} from "../src/demo-safety.ts";
import {
  loadPrivateKeypair,
  authorizationInstruction,
  verifyAuthorization,
} from "../src/observation-authorization.ts";
import { PathnodObservationSubmissionAdapter } from "../src/observation-adapter.ts";
import { signatureBase58 } from "../src/solana-observation-relay.ts";
import {
  gate2Snapshot,
  nullifierRejection,
  sameGate2Accounting,
  type Gate2Snapshot,
} from "../src/gate2-evidence.ts";
import type { ObservationRelayPayload } from "../src/observation-relay.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Config = {
  version: 1;
  bootstrapReport: string;
  verifierConfig: string;
  stateDirectory: string;
  transcriptHash?: string;
  video?: string;
};
type Replay = {
  version: 1;
  target: string;
  hash: string;
  wire: string;
  signature: string;
  lastValidBlockHeight: number;
  before: Gate2Snapshot;
  after?: Gate2Snapshot;
  state: "prepared" | "submitted" | "rejected";
};
async function atomic(file: string, value: unknown) {
  const h = await open(file + ".next", "w", 0o600);
  try {
    await h.writeFile(JSON.stringify(value, null, 2) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(file + ".next", file);
}
function validateWire(
  wire: Buffer,
  payer: PublicKey,
  table: AddressLookupTableAccount,
  instructions: TransactionInstruction[],
) {
  const tx = VersionedTransaction.deserialize(wire);
  assert.ok(tx.message instanceof MessageV0);
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.ok(tx.message.staticAccountKeys[0]!.equals(payer));
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      payer.toBuffer(),
    ]),
    format: "der",
    type: "spki",
  });
  assert.ok(
    verify(null, tx.message.serialize(), key, tx.signatures[0]!),
    "Invalid saved transaction signature",
  );
  const keys = tx.message.getAccountKeys({
    addressLookupTableAccounts: [table],
  });
  assert.equal(tx.message.compiledInstructions.length, instructions.length);
  for (const [i, expected] of instructions.entries()) {
    const actual: {
      programIdIndex: number;
      accountKeyIndexes: number[];
      data: Uint8Array;
    } = tx.message.compiledInstructions[i]!;
    assert.ok(keys.get(actual.programIdIndex)?.equals(expected.programId));
    assert.ok(Buffer.from(actual.data).equals(expected.data));
    assert.equal(actual.accountKeyIndexes.length, expected.keys.length);
    actual.accountKeyIndexes.forEach((index, j) =>
      assert.ok(keys.get(index)?.equals(expected.keys[j]!.pubkey)),
    );
  }
  return tx;
}
async function main() {
  const [flag, file, action] = process.argv.slice(2).filter((x) => x !== "--");
  assert.equal(flag, "--config");
  assert.ok(
    file && ["check", "status", "replay", "report"].includes(action ?? ""),
    "Usage: --config /private/gate2.json check|status|replay|report",
  );
  const config = JSON.parse(
    await readFile(await privateFile(file!, repo), "utf8"),
  ) as Config;
  assert.equal(config.version, 1);
  const report = JSON.parse(
    await readFile(await externalFile(config.bootstrapReport, repo), "utf8"),
  );
  assert.ok(
    report.complete &&
      report.developmentOnly &&
      report.cluster === "devnet" &&
      report.genesis === DEVNET_GENESIS &&
      report.simulated?.length === 0,
    "Gate 2 requires a completed hardware-mode devnet bootstrap",
  );
  const env = JSON.parse(
    await readFile(await privateFile(config.verifierConfig, repo), "utf8"),
  ) as Record<string, unknown>;
  const setting = (name: string) => {
    const value = env[name];
    assert.ok(typeof value === "string" && value);
    return value;
  };
  assert.equal(
    setting("PATHNOD_OBSERVATION_RPC_URL"),
    "https://api.devnet.solana.com",
  );
  assert.equal(setting("PATHNOD_OBSERVATION_GENESIS"), DEVNET_GENESIS);
  assert.equal(setting("PATHNOD_OBSERVATION_PROGRAM_ID"), report.program);
  assert.equal(setting("PATHNOD_OBSERVATION_PROTOCOL_ID"), report.protocol);
  const program = new PublicKey(report.program),
    protocol = String(report.protocol);
  assert.ok(path.isAbsolute(config.stateDirectory));
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await externalFile(config.stateDirectory, repo);
  assert.equal((await stat(directory)).mode & 0o077, 0);
  const lock = await open(path.join(directory, "run.lock"), "wx", 0o600).catch(
    () => {
      throw Error(
        "Gate 2 state locked; inspect the owning PID before removing a stale lock",
      );
    },
  );
  await lock.writeFile(String(process.pid));
  try {
    const db = new DatabaseSync(
      await privateFile(setting("PATHNOD_ENROLLMENT_DB"), repo),
      { readOnly: true },
    );
    const prefix = `${DEVNET_GENESIS}/${report.program}/${protocol}/`;
    assert.ok(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='observation_policy_target'",
        )
        .get(),
      "Start the correctly configured verifier before the Gate 2 check",
    );
    const marker = db
      .prepare("SELECT target FROM observation_policy_target WHERE id=1")
      .get();
    assert.ok(
      marker && String(marker.target).startsWith(prefix),
      "Verifier database is not bound to this Gate 2 deployment; integrate the DEV-37 runtime-database correction before recording",
    );
    let last = 0;
    const connection = new Connection("https://api.devnet.solana.com", {
      commitment: "finalized",
      disableRetryOnRateLimit: true,
      fetch: async (input, init) => {
        await pause(Math.max(0, 1000 - (Date.now() - last)));
        last = Date.now();
        return fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
      },
    });
    assert.equal(await connection.getGenesisHash(), DEVNET_GENESIS);
    const adapter = new PathnodObservationSubmissionAdapter(
      String(report.circuitKeyDigest),
    );
    await adapter.validateTarget(connection, program);
    if (action === "check") {
      db.close();
      console.log(
        "Gate 2 configuration and circuit metadata match the hardware deployment.",
      );
      return;
    }
    const jobs = db
      .prepare(
        "SELECT transcript_hash,status,signature,payload FROM observation_relay_jobs",
      )
      .all()
      .filter((row) => {
        const value = JSON.parse(
          String(row.payload),
        ) as ObservationRelayPayload;
        return (
          value.protocolID === protocol &&
          value.deviceID === report.device &&
          (!config.transcriptHash ||
            row.transcript_hash === config.transcriptHash)
        );
      });
    assert.equal(
      jobs.length,
      1,
      "Capture one real observation, or select its transcriptHash explicitly",
    );
    const job = jobs[0]!;
    const payload = JSON.parse(String(job.payload)) as ObservationRelayPayload;
    db.close();
    assert.equal(payload.transcriptHash, job.transcript_hash);
    assert.ok(
      verifyAuthorization(payload, payload.verifier, payload.verifierSignature),
    );
    assert.equal(
      job.status,
      "confirmed",
      "Wait for the real relay's finalized confirmation",
    );
    assert.equal(payload.observerClass, 1);
    assert.ok(
      typeof job.signature === "string",
      "Reconcile the successful observation signature before recording Gate 2",
    );
    const originalStatus = (
      await connection.getSignatureStatuses([job.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    assert.ok(
      originalStatus?.confirmationStatus === "finalized" &&
        originalStatus.err === null,
      "The recorded observation transaction is not finalized successfully",
    );
    const current = await gate2Snapshot(connection, program, payload);
    assert.equal(current.gross, "50000");
    assert.equal(current.fees, "10000");
    const journalFile = path.join(directory, "duplicate.json");
    let replay: Replay | undefined;
    try {
      replay = JSON.parse(
        await readFile(await privateFile(journalFile, repo), "utf8"),
      ) as Replay;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (action === "status") {
      console.log(
        JSON.stringify(
          {
            status: "finalized",
            transaction: job.signature,
            snapshot: current,
            duplicate: replay?.state ?? "not_attempted",
          },
          null,
          2,
        ),
      );
      return;
    }
    if (action === "replay") {
      const payer = await loadPrivateKeypair(
        await privateFile(setting("PATHNOD_OBSERVATION_RELAYER_PAYER"), repo),
      );
      const lookup = setting("PATHNOD_OBSERVATION_LOOKUP_TABLE");
      assert.equal(lookup, report.addresses.lookup);
      const table = (
        await connection.getAddressLookupTable(new PublicKey(lookup), {
          commitment: "finalized",
        })
      ).value;
      assert.ok(
        table && table.state.deactivationSlot === 0xffff_ffff_ffff_ffffn,
      );
      const target = `${DEVNET_GENESIS}/${program.toBase58()}/${protocol}/${payer.publicKey.toBase58()}/${lookup}/${payload.transcriptHash}`;
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 299999 }),
        authorizationInstruction(
          payload,
          payload.verifier,
          payload.verifierSignature,
        ),
        adapter.instruction(program, payer.publicKey, payload),
      ];
      if (!replay) {
        const latest = await connection.getLatestBlockhash("finalized"),
          tx = new VersionedTransaction(
            new TransactionMessage({
              payerKey: payer.publicKey,
              recentBlockhash: latest.blockhash,
              instructions,
            }).compileToV0Message([table]),
          );
        tx.sign([payer]);
        const wire = Buffer.from(tx.serialize());
        assert.ok(wire.length <= 1232);
        replay = {
          version: 1,
          target,
          hash: payload.transcriptHash,
          wire: wire.toString("base64"),
          signature: signatureBase58(tx.signatures[0]!),
          lastValidBlockHeight: latest.lastValidBlockHeight,
          before: current,
          state: "prepared",
        };
        await atomic(journalFile, replay);
      }
      assert.equal(replay.version, 1);
      assert.equal(replay.target, target);
      assert.equal(replay.hash, payload.transcriptHash);
      const tx = validateWire(
        Buffer.from(replay.wire, "base64"),
        payer.publicKey,
        table,
        instructions,
      );
      assert.equal(signatureBase58(tx.signatures[0]!), replay.signature);
      const status = (
        await connection.getSignatureStatuses([replay.signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (!status) {
        assert.ok(
          (await connection.getBlockHeight("finalized")) <=
            replay.lastValidBlockHeight,
          "Expired ambiguous duplicate transaction: inspect history and journal; do not automatically replace it",
        );
        replay.state = "submitted";
        await atomic(journalFile, replay);
        assert.equal(
          await connection.sendRawTransaction(
            Buffer.from(replay.wire, "base64"),
            { skipPreflight: true, maxRetries: 0 },
          ),
          replay.signature,
        );
      }
      let rejected = false;
      for (let attempt = 0; attempt < 45; attempt++) {
        const result = (
          await connection.getSignatureStatuses([replay.signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (result?.confirmationStatus === "finalized") {
          assert.ok(
            nullifierRejection(result.err),
            "Duplicate did not fail with E_NULLIFIER",
          );
          assert.equal(
            (result.err as { InstructionError: [number, unknown] })
              .InstructionError[0],
            2,
          );
          rejected = true;
          break;
        }
        await pause(1000);
      }
      assert.ok(
        rejected,
        "Duplicate outcome remains ambiguous; resume the same journal later",
      );
      const after = await gate2Snapshot(connection, program, payload);
      assert.ok(
        sameGate2Accounting(replay.before, after),
        "Accounting changed during the duplicate check; inspect before declaring Gate 2 passed",
      );
      replay.after = after;
      replay.state = "rejected";
      await atomic(journalFile, replay);
      const runtime = new DatabaseSync(
        await privateFile(setting("PATHNOD_ENROLLMENT_DB"), repo),
      );
      try {
        runtime.exec(
          "CREATE TABLE IF NOT EXISTS gate2_replays_v0 (transcript_hash TEXT PRIMARY KEY, signature TEXT NOT NULL, error_code INTEGER NOT NULL, unchanged INTEGER NOT NULL)",
        );
        runtime
          .prepare(
            "INSERT INTO gate2_replays_v0 VALUES (?,?,6001,1) ON CONFLICT(transcript_hash) DO UPDATE SET signature=excluded.signature,error_code=6001,unchanged=1",
          )
          .run(payload.transcriptHash, replay.signature);
      } finally {
        runtime.close();
      }
      console.log(
        `E_NULLIFIER: finalized duplicate rejected; accounting unchanged. ${replay.signature}`,
      );
      return;
    }
    assert.ok(
      replay?.state === "rejected" &&
        replay.after &&
        sameGate2Accounting(replay.before, replay.after),
      "Finalize and verify the duplicate before issuing Gate 2 evidence",
    );
    assert.ok(
      config.video,
      "Record the raw iPhone video before completing Gate 2",
    );
    const video = await externalFile(config.video, repo),
      videoInfo = await stat(video);
    assert.ok(
      videoInfo.isFile() &&
        videoInfo.size > 1024 &&
        [".mov", ".mp4"].includes(path.extname(video).toLowerCase()),
    );
    const media = JSON.parse(
      (
        await promisify(execFile)(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            video,
          ],
          { timeout: 15000, maxBuffer: 1000000 },
        )
      ).stdout,
    ) as {
      streams: { codec_type: string; width?: number; height?: number }[];
      format: { duration: string };
    };
    const duration = Number(media.format.duration);
    assert.ok(
      Number.isFinite(duration) &&
        duration >= 3 &&
        media.streams.some(
          (s) =>
            s.codec_type === "video" &&
            (s.width ?? 0) > 0 &&
            (s.height ?? 0) > 0,
        ),
      "Record a playable raw video of the physical session",
    );
    const videoHash = createHash("sha256");
    for await (const chunk of createReadStream(video)) videoHash.update(chunk);
    const evidence = {
      version: 1,
      gate: "DEV-38",
      complete: true,
      hardware: true,
      network: "devnet",
      program: report.program,
      protocol,
      device: report.device,
      transcriptHash: payload.transcriptHash,
      observation: { signature: job.signature, snapshot: current },
      duplicate: {
        signature: replay.signature,
        error: "E_NULLIFIER",
        unchanged: true,
      },
      video: {
        sha256: videoHash.digest("hex"),
        bytes: videoInfo.size,
        durationSeconds: duration,
        internalOnly: true,
      },
      simulated: [],
      recordedAt: new Date().toISOString(),
    };
    await atomic(path.join(directory, "report.json"), evidence);
    console.log(
      "Gate 2 evidence written; recording remains private and outside Git.",
    );
  } finally {
    await lock.close();
    await unlink(path.join(directory, "run.lock"));
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Gate 2 failed");
  process.exitCode = 1;
});
