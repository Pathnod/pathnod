import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hex32, verifyAuthorization, type ObservationAuthorization } from "./observation-authorization.ts";

export interface ObservationRelayPayload extends ObservationAuthorization {
  protocolID: string; deviceID: string; evidenceHash: string; epoch: number;
  proofBytes: string; verifier: string; verifierSignature: string;
}
export interface PreparedObservationTransaction { wire: string; signature: string; lastValidBlockHeight: number }
function validPayload(payload: ObservationRelayPayload): boolean {
  try {
    hex32(payload.protocolID); hex32(payload.deviceID); hex32(payload.evidenceHash);
    if (!/^[a-f0-9]{960}$/.test(payload.proofBytes) || !Number.isInteger(payload.epoch) ||
        payload.epoch < 0 || payload.epoch > 0xffff_ffff) return false;
    const proof = Buffer.from(payload.proofBytes, "hex");
    return proof.subarray(384, 416).equals(hex32(payload.nullifier)) && proof.subarray(416, 448).equals(hex32(payload.pseudonym)) &&
      BigInt("0x" + proof.subarray(352, 384).toString("hex")) === BigInt(payload.epoch) &&
      BigInt("0x" + proof.subarray(448, 480).toString("hex")) === BigInt(payload.observerClass) &&
      verifyAuthorization(payload, payload.verifier, payload.verifierSignature);
  } catch { return false; }
}
export interface ObservationRelayTransport {
  readonly target: string;
  /** Recheck pinned program/config, verifier key, policy, accepted root and nullifier before broadcasting. */
  eligible(payload: ObservationRelayPayload): Promise<boolean>;
  prepare(payload: ObservationRelayPayload): Promise<PreparedObservationTransaction>;
  send(transaction: PreparedObservationTransaction): Promise<void>;
  inspect(transaction: PreparedObservationTransaction, payload: ObservationRelayPayload): Promise<"missing" | "pending" | "confirmed" | "failed">;
  expired(transaction: PreparedObservationTransaction): Promise<boolean>;
}
export function initializeObservationRelay(db: DatabaseSync, target: string, verifier: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS observation_relay_target (id INTEGER PRIMARY KEY CHECK(id=1), target TEXT NOT NULL, verifier TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observation_relay_jobs (
      nullifier TEXT PRIMARY KEY, transcript_hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','submitted','confirmed','failed')),
      wire TEXT, signature TEXT, last_valid_height INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, generations INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT);
    CREATE TABLE IF NOT EXISTS observation_relay_transport (id INTEGER PRIMARY KEY CHECK(id=1), target TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO observation_relay_target VALUES (1, ?, ?)").run(target, verifier);
  const row = db.prepare("SELECT * FROM observation_relay_target WHERE id=1").get();
  if (row?.target !== target || row.verifier !== verifier) throw Error("Relay database target/key mismatch");
}
/** Called only inside the DEV-33 final counter/receipt transaction. No public HTTP enqueue API. */
export function queueValidatedObservation(db: DatabaseSync, payload: ObservationRelayPayload, capacity: number): void {
  if (!db.isTransaction || !validPayload(payload)) throw Error("Invalid relay handoff");
  const receipt = db.prepare("SELECT nullifier FROM observation_validations_v0 WHERE transcript_hash=?").get(payload.transcriptHash);
  if (receipt?.nullifier !== payload.nullifier) throw Error("Missing policy validation");
  if (Number(db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n) >= capacity) throw Error("Relay capacity reached");
  db.prepare("INSERT INTO observation_relay_jobs (nullifier, transcript_hash, payload, status) VALUES (?, ?, ?, 'queued')")
    .run(payload.nullifier, payload.transcriptHash, JSON.stringify(payload));
}
interface Job {
  nullifier: string; transcript_hash: string; payload: string; status: string;
  wire: string | null; signature: string | null; last_valid_height: number | null;
  attempts: number; generations: number; retry_at: number;
}
/** One live worker per SQLite file; dead-process ownership is recoverable without changing jobs. */
export class ObservationRelayer {
  readonly #db: DatabaseSync;
  readonly #transport: ObservationRelayTransport;
  readonly #now: () => number;
  #running: Promise<void> | undefined;
  #closed = false;
  readonly #owner = randomUUID();
  #closing: Promise<void> | undefined;
  constructor(path: string, policyTarget: string, verifier: string, transport: ObservationRelayTransport, now = Date.now) {
    this.#db = new DatabaseSync(path); this.#transport = transport; this.#now = now;
    try {
      initializeObservationRelay(this.#db, policyTarget, verifier);
      if (!transport.target) throw Error("Missing transport target");
      this.#db.prepare("INSERT OR IGNORE INTO observation_relay_transport VALUES (1, ?)").run(transport.target);
      if (this.#db.prepare("SELECT target FROM observation_relay_transport WHERE id=1").get()?.target !== transport.target) {
        throw Error("Relay transport target mismatch");
      }
      this.#db.exec("CREATE TABLE IF NOT EXISTS observation_relay_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL)");
      this.#db.exec("BEGIN IMMEDIATE");
      const owner = this.#db.prepare("SELECT pid FROM observation_relay_owner WHERE id=1").get();
      if (owner) {
        let dead = false;
        try { process.kill(Number(owner.pid), 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        if (!dead) throw Error("A relay worker already owns this database");
      }
      this.#db.prepare("INSERT OR REPLACE INTO observation_relay_owner VALUES (1, ?, ?)").run(process.pid, this.#owner);
      this.#db.exec("COMMIT");
    } catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); this.#db.close(); throw error; }
  }
  status(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid transcript hash");
    const row = this.#db.prepare("SELECT status, signature, attempts, retry_at, last_error FROM observation_relay_jobs WHERE transcript_hash=?").get(hash);
    return row ? { status: String(row.status), signature: row.signature, attempts: row.attempts,
      retry_at: row.retry_at, last_error: row.last_error, on_chain: row.status === "confirmed", paid: false } : undefined;
  }
  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#running ??= this.#tick().finally(() => { this.#running = undefined; });
  }
  close(): Promise<void> {
    this.#closed = true;
    return this.#closing ??= (async () => {
      try { await this.#running; }
      finally { this.#db.prepare("DELETE FROM observation_relay_owner WHERE id=1 AND token=?").run(this.#owner); this.#db.close(); }
    })();
  }
  async #tick(): Promise<void> {
    const jobs = this.#db.prepare("SELECT * FROM observation_relay_jobs WHERE status IN ('queued','submitted') AND retry_at<=? ORDER BY rowid LIMIT 16")
      .all(this.#now()) as unknown as Job[];
    for (const job of jobs) {
      try { await this.#process(job); }
      catch {
        this.#db.prepare("UPDATE observation_relay_jobs SET attempts=attempts+1, retry_at=?, last_error='retryable_failure' WHERE nullifier=?")
          .run(this.#now() + Math.min(3_600_000, 1000 * 2 ** Math.min(12, job.attempts + 1)), job.nullifier);
      }
    }
  }
  async #process(job: Job): Promise<void> {
    const payload = JSON.parse(job.payload) as ObservationRelayPayload;
    const verifier = this.#db.prepare("SELECT verifier FROM observation_relay_target WHERE id=1").get()?.verifier;
    if (payload.nullifier !== job.nullifier || payload.transcriptHash !== job.transcript_hash || payload.verifier !== verifier ||
        !validPayload(payload)) {
      this.#fail(job, "invalid_authorization"); return;
    }
    let transaction = job.wire && job.signature && job.last_valid_height !== null
      ? { wire: job.wire, signature: job.signature, lastValidBlockHeight: job.last_valid_height } : undefined;
    if (transaction) {
      const state = await this.#transport.inspect(transaction, payload);
      if (state === "confirmed") { this.#db.prepare("UPDATE observation_relay_jobs SET status='confirmed', last_error=NULL WHERE nullifier=?").run(job.nullifier); return; }
      if (state === "failed") { this.#fail(job, "transaction_failed"); return; }
      if (state === "pending") { this.#retry(job); return; }
      if (await this.#transport.expired(transaction)) {
        // Inspect history again AFTER observing expiry before replacing signed bytes.
        const after = await this.#transport.inspect(transaction, payload);
        if (after === "confirmed") { this.#db.prepare("UPDATE observation_relay_jobs SET status='confirmed', last_error=NULL WHERE nullifier=?").run(job.nullifier); return; }
        if (after === "failed") { this.#fail(job, "transaction_failed"); return; }
        if (after !== "missing") { this.#retry(job); return; }
        transaction = undefined;
      }
    }
    if (!await this.#transport.eligible(payload)) {
      // A changed account snapshot blocks another broadcast, but does not resolve
      // signed bytes already sent. Keep reconciling while their blockhash is valid.
      // transaction is cleared only after expiry and a second missing-history check.
      if (transaction) this.#retry(job);
      else this.#fail(job, "policy_or_chain_changed");
      return;
    }
    if (!transaction) {
      if (job.generations >= 8) { this.#fail(job, "replacement_limit"); return; }
      transaction = await this.#transport.prepare(payload);
      if (!transaction.wire || transaction.wire.length > 2048 || !transaction.signature ||
          !Number.isSafeInteger(transaction.lastValidBlockHeight) || transaction.lastValidBlockHeight < 0) throw Error("Invalid prepared transaction");
      // Persist bytes, signature and expiry BEFORE any network send, including an ambiguous send failure.
      this.#db.prepare("UPDATE observation_relay_jobs SET status='submitted', wire=?, signature=?, last_valid_height=?, generations=generations+1 WHERE nullifier=?")
        .run(transaction.wire, transaction.signature, transaction.lastValidBlockHeight, job.nullifier);
    }
    await this.#transport.send(transaction);
    this.#retry(job);
  }
  #retry(job: Job): void {
    this.#db.prepare("UPDATE observation_relay_jobs SET retry_at=?, last_error=NULL WHERE nullifier=?").run(this.#now() + 2000, job.nullifier);
  }
  #fail(job: Job, code: string): void {
    this.#db.prepare("UPDATE observation_relay_jobs SET status='failed', last_error=? WHERE nullifier=?").run(code, job.nullifier);
  }
}
