import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, mkdir, open, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  Connection,
  PublicKey,
  Transaction,
  Ed25519Program,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  publishConfidence,
  confidenceAuthorizationDigest,
  decodeDeviceEpoch,
  type ConfidenceAuthorization,
} from "@pathnod/solana";
import {
  DEVNET_GENESIS,
  privateFile,
  externalFile,
  demoTarget,
} from "../src/demo-safety.ts";
import {
  loadPrivateKeypair,
  loadObservationSigner,
  verifyAuthorization,
} from "../src/observation-authorization.ts";
import { signatureBase58 } from "../src/solana-observation-relay.ts";
import {
  ConfidenceRecorder,
  openConfidenceInput,
} from "../src/confidence-store.ts";
import { readConfidenceSnapshot } from "../src/confidence-chain.ts";
import {
  recoverConfidencePublication,
  writeConfidenceArtifact as atomic,
  type ConfidencePublicationJournal as Journal,
} from "../src/confidence-recovery.ts";
import {
  decodeObservationTranscript,
  observationTranscriptHash,
} from "../src/observation-transcript.ts";
import {
  type ConfidenceInput,
  confidenceCommitment,
} from "../src/confidence.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Config {
  version: 1;
  verifierConfig: string;
  requesterPrivateKey: string;
  stateDirectory: string;
  deviceID: string;
  epoch: number;
  transcriptOrder?: string[];
  importInputs?: string;
  localValidator?: boolean;
}
function authorization(journal: Journal): ConfidenceAuthorization {
  const s = journal.report.scope;
  return {
    epoch: s.epoch,
    observationRoot: s.observationRoot,
    observerCount: s.transcriptOrder.length,
    previousCommitment: journal.previousCommitment,
    commitment: journal.commitment,
    policyVersion: s.policyVersion,
    evaluatedAtMilliseconds: BigInt(s.evaluatedAtMilliseconds),
  };
}
function validateWire(
  journal: Journal,
  payer: PublicKey,
  expected: ReturnType<typeof publishConfidence>,
  digest: Buffer,
  verifier: PublicKey,
): Transaction {
  const wire = Buffer.from(journal.wire, "base64"),
    tx = Transaction.from(wire);
  assert.ok(tx.verifySignatures());
  assert.ok(tx.feePayer?.equals(payer));
  assert.equal(tx.signatures.length, 1);
  assert.equal(signatureBase58(tx.signature!), journal.signature);
  assert.equal(tx.instructions.length, 3);
  const [budget, ed, consumer] = tx.instructions;
  assert.ok(budget!.programId.equals(ComputeBudgetProgram.programId));
  assert.deepEqual(
    budget!.data,
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }).data,
  );
  const edExpected = Ed25519Program.createInstructionWithPublicKey({
    publicKey: verifier.toBuffer(),
    signature: ed!.data.subarray(48, 112),
    message: digest,
  });
  assert.ok(ed!.programId.equals(edExpected.programId));
  assert.equal(ed!.keys.length, 0);
  assert.deepEqual(ed!.data, edExpected.data);
  assert.ok(consumer!.programId.equals(expected.programId));
  assert.deepEqual(consumer!.data, expected.data);
  assert.deepEqual(consumer!.keys, expected.keys);
  return tx;
}
async function main() {
  const args = process.argv.slice(2).filter((v) => v !== "--");
  assert.equal(args[0], "--config");
  assert.equal(args.length, 3);
  const action = args[2]!;
  assert.ok(
    ["import", "compute", "publish", "status", "report"].includes(action),
  );
  const c = JSON.parse(
    await readFile(await privateFile(path.resolve(args[1]!), repo), "utf8"),
  ) as Config;
  assert.equal(c.version, 1);
  assert.ok(/^[a-f0-9]{64}$/.test(c.deviceID));
  assert.ok(
    Number.isInteger(c.epoch) && c.epoch >= 0 && c.epoch <= 0xffff_ffff,
  );
  const env = JSON.parse(
    await readFile(await privateFile(c.verifierConfig, repo), "utf8"),
  ) as Record<string, unknown>;
  const setting = (name: string) => {
    const value = env[name];
    assert.ok(typeof value === "string" && value);
    return value;
  };
  const targetRPC = demoTarget(
    setting("PATHNOD_OBSERVATION_RPC_URL"),
    c.localValidator,
    setting("PATHNOD_OBSERVATION_GENESIS"),
  );
  assert.ok(c.localValidator || targetRPC.expected === DEVNET_GENESIS);
  assert.equal(
    c.localValidator === true,
    targetRPC.local,
    "Local-validator flag must match the actual RPC target",
  );
  const program = new PublicKey(setting("PATHNOD_OBSERVATION_PROGRAM_ID")),
    protocol = Buffer.from(setting("PATHNOD_OBSERVATION_PROTOCOL_ID"), "hex");
  assert.equal(protocol.length, 32);
  const recipient = createPrivateKey(
    await readFile(await privateFile(c.requesterPrivateKey, repo)),
  );
  assert.equal(recipient.asymmetricKeyType, "x25519");
  const directory = await externalFile(c.stateDirectory, repo).catch(
    async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      assert.ok(path.isAbsolute(c.stateDirectory));
      await mkdir(c.stateDirectory, { recursive: true, mode: 0o700 });
      return externalFile(c.stateDirectory, repo);
    },
  );
  assert.equal(
    (await stat(directory)).mode & 0o077,
    0,
    "Confidence state directory must be private (chmod 700)",
  );
  const lock = await open(path.join(directory, "run.lock"), "wx", 0o600);
  await lock.writeFile(String(process.pid));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(
      await privateFile(setting("PATHNOD_ENROLLMENT_DB"), repo),
    );
    const target = String(
      db
        .prepare("SELECT target FROM observation_policy_target WHERE id=1")
        .get()?.target,
    );
    assert.ok(
      target.startsWith(
        `${targetRPC.expected}/${program.toBase58()}/${protocol.toString("hex")}/`,
      ),
      "Confidence database is bound to another deployment",
    );
    const recorder = new ConfidenceRecorder(createPublicKey(recipient));
    recorder.initialize(db);
    if (action === "import") {
      assert.ok(c.importInputs);
      const inputs = JSON.parse(
        await readFile(await privateFile(c.importInputs, repo), "utf8"),
      ) as ConfidenceInput[];
      assert.ok(
        Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 10000,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const input of inputs) {
          assert.equal(
            input.reenrollmentCount,
            null,
            "Historical imports cannot invent enrollment risk metrics",
          );
          assert.ok(
            Object.keys(input).every((k) =>
              ["transcript", "evidence", "reenrollmentCount"].includes(k),
            ),
          );
          const t = decodeObservationTranscript(
              Buffer.from(input.transcript, "base64"),
            ),
            hash = observationTranscriptHash(t).toString("hex");
          assert.equal(
            Buffer.from(t.protocolID).toString("hex"),
            protocol.toString("hex"),
          );
          const row = db
            .prepare(
              "SELECT j.payload FROM observation_relay_jobs j JOIN observation_validations_v0 v USING(transcript_hash) WHERE j.transcript_hash=?",
            )
            .get(hash);
          assert.ok(
            row,
            "Historical transcript must match an existing validated relay payload",
          );
          const payload = JSON.parse(String(row.payload));
          assert.equal(payload.transcriptHash, hash);
          assert.ok(
            verifyAuthorization(
              payload,
              payload.verifier,
              payload.verifierSignature,
            ),
          );
          const prior: Record<string, unknown> | undefined = db
            .prepare(
              "SELECT sealed,target FROM confidence_inputs_v0 WHERE transcript_hash=?",
            )
            .get(hash);
          if (prior) {
            assert.deepEqual(
              openConfidenceInput(
                recipient,
                String(prior.target),
                hash,
                String(prior.sealed),
              ),
              input,
            );
          } else recorder.record(db, target, hash, input);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      console.log(
        "Authenticated historical transcripts encrypted for the requester; no key ID or assertion retained.",
      );
      return;
    }
    const inputs = new Map<string, ConfidenceInput>();
    for (const row of db
      .prepare("SELECT * FROM confidence_inputs_v0 WHERE target=?")
      .all(target)) {
      inputs.set(
        String(row.transcript_hash),
        openConfidenceInput(
          recipient,
          target,
          String(row.transcript_hash),
          String(row.sealed),
        ),
      );
    }
    let last = 0;
    const connection = new Connection(targetRPC.rpc.href, {
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
    assert.equal(await connection.getGenesisHash(), targetRPC.expected);
    const deployed = await connection.getAccountInfo(program, "finalized");
    assert.ok(deployed?.executable, "Confidence program is not executable");
    const journalFile = path.join(directory, "publication.json");
    let journal: Journal | undefined;
    try {
      journal = JSON.parse(
        await readFile(await privateFile(journalFile, repo), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (journal) {
      assert.equal(journal.version, 1);
      assert.equal(journal.target, target);
      assert.equal(confidenceCommitment(journal.report), journal.commitment);
    }
    let computed: { report: Journal["report"]; commitment: string } | undefined;
    if (!journal && action !== "compute") {
      try {
        computed = JSON.parse(
          await readFile(
            await privateFile(path.join(directory, "computed.json"), repo),
            "utf8",
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (computed)
        assert.equal(
          confidenceCommitment(computed.report),
          computed.commitment,
        );
    }
    const snapshot = await readConfidenceSnapshot(
      connection,
      program,
      protocol,
      Buffer.from(c.deviceID, "hex"),
      c.epoch,
      inputs,
      journal?.report.scope.transcriptOrder ??
        computed?.report.scope.transcriptOrder ??
        c.transcriptOrder,
      journal?.report.scope.evaluatedAtMilliseconds ??
        computed?.report.scope.evaluatedAtMilliseconds ??
        Date.now(),
    );
    if (computed)
      assert.equal(
        snapshot.commitment,
        computed.commitment,
        "Computed inputs changed; compute a fresh report before publishing",
      );
    if (journal)
      assert.equal(
        snapshot.commitment,
        journal.commitment,
        "Confidence inputs changed; reconcile this journal before preparing a new run",
      );
    const existing = snapshot.deviceEpoch.confidenceCommitment.toString("hex");
    if (action === "compute") {
      assert.ok(!journal, "Use status to inspect an existing publication");
      await atomic(path.join(directory, "computed.json"), {
        report: snapshot.report,
        commitment: snapshot.commitment,
      });
      console.log(
        `Computed ${snapshot.commitment}; ${snapshot.report.status}; no transaction sent.`,
      );
      return;
    }
    if (!journal) {
      assert.equal(
        action,
        "publish",
        "Publish the computed confidence before inspecting its transaction",
      );
      const signer = await loadObservationSigner(
        await privateFile(setting("PATHNOD_OBSERVATION_VERIFIER_SIGNER"), repo),
      );
      assert.equal(signer.publicKey, snapshot.config.verifier.toBase58());
      const payer = await loadPrivateKeypair(
        await privateFile(setting("PATHNOD_OBSERVATION_RELAYER_PAYER"), repo),
      );
      const latest = await connection.getLatestBlockhash("finalized");
      journal = {
        version: 1,
        target,
        report: snapshot.report,
        commitment: snapshot.commitment,
        previousCommitment: existing,
        wire: "",
        signature: "",
        lastValidBlockHeight: latest.lastValidBlockHeight,
        state: "prepared",
      };
      const authorizationArgs = authorization(journal),
        digest = confidenceAuthorizationDigest(
          program,
          protocol,
          Buffer.from(c.deviceID, "hex"),
          authorizationArgs,
        );
      const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        Ed25519Program.createInstructionWithPublicKey({
          publicKey: snapshot.config.verifier.toBuffer(),
          signature: Buffer.from(signer.signClaimDigest(digest), "hex"),
          message: digest,
        }),
        publishConfidence(
          program,
          protocol,
          Buffer.from(c.deviceID, "hex"),
          authorizationArgs,
        ),
      );
      tx.sign(payer);
      journal.wire = tx.serialize().toString("base64");
      journal.signature = signatureBase58(tx.signature!);
      await atomic(journalFile, journal);
    }
    const payer = await loadPrivateKeypair(
      await privateFile(setting("PATHNOD_OBSERVATION_RELAYER_PAYER"), repo),
    );
    const authorizationArgs = authorization(journal),
      digest = confidenceAuthorizationDigest(
        program,
        protocol,
        Buffer.from(c.deviceID, "hex"),
        authorizationArgs,
      );
    validateWire(
      journal,
      payer.publicKey,
      publishConfidence(
        program,
        protocol,
        Buffer.from(c.deviceID, "hex"),
        authorizationArgs,
      ),
      digest,
      snapshot.config.verifier,
    );
    assert.ok(
      action === "publish" || action === "status" || action === "report",
    );
    await recoverConfidencePublication(
      journal,
      {
        inspect: async (signature) =>
          (
            await connection.getSignatureStatuses([signature], {
              searchTransactionHistory: true,
            })
          ).value[0] ?? null,
        blockHeight: () => connection.getBlockHeight("finalized"),
        send: (wire) =>
          connection.sendRawTransaction(wire, {
            skipPreflight: false,
            maxRetries: 0,
          }),
        save: (value) => atomic(journalFile, value),
        snapshot: async () => {
          const row = await connection.getAccountInfo(
            snapshot.addresses.deviceEpoch,
            "finalized",
          );
          assert.ok(row && !row.executable && row.owner.equals(program));
          const state = decodeDeviceEpoch(row.data);
          return {
            commitment: state.confidenceCommitment.toString("hex"),
            observationRoot: state.observationRoot.toString("hex"),
            observerCount: state.independentObservers,
            paidSlotsUsed: state.paidSlotsUsed,
          };
        },
      },
      {
        action,
        currentCommitment: existing,
        paidSlotsUsed: snapshot.deviceEpoch.paidSlotsUsed,
      },
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS confidence_reports_v0 (device_id TEXT NOT NULL, epoch INTEGER NOT NULL, target TEXT NOT NULL, commitment TEXT NOT NULL, report TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(device_id,epoch,target))",
    );
    db.prepare(
      "INSERT INTO confidence_reports_v0 VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,epoch,target) DO UPDATE SET commitment=excluded.commitment,report=excluded.report,signature=excluded.signature",
    ).run(
      c.deviceID,
      c.epoch,
      target,
      journal.commitment,
      JSON.stringify(journal.report),
      journal.signature,
    );
    await atomic(path.join(directory, "report.json"), {
      version: 1,
      network: c.localValidator ? "local-validator" : "devnet",
      report: journal.report,
      commitment: journal.commitment,
      signature: journal.signature,
      finalized: true,
    });
    console.log(
      `Finalized confidence ${journal.commitment}; ${journal.report.status}; ${journal.signature}`,
    );
  } finally {
    db?.close();
    await lock.close();
    await unlink(path.join(directory, "run.lock"));
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Confidence validation failed",
  );
  process.exitCode = 1;
});
