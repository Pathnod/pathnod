import { createHash, createPublicKey, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AppAttestVerifier, type AppAttestPolicy, type VerifiedAppAttestKey } from "./app-attest.ts";
import { parseObservationEnvelope, type ObservationEnvelope } from "./observation-inbox.ts";
import { decodeObservationTranscript, type ObservationTranscript, type TranscriptChallenge } from "./observation-transcript.ts";
import { ObservationSigner, relayProofBytes } from "./observation-authorization.ts";
import { initializeObservationRelay, queueValidatedObservation, type ObservationRelayPayload } from "./observation-relay.ts";
import { claimDigest, type ClaimAuthorization } from '@pathnod/solana';
import type { ObservationChainStatus } from './observation-status.ts';

export type ObservationPolicyCode = "E_DEVICE_UNKNOWN" | "E_DEV_SIG" | "E_DEV_COUNTER" | "E_RTT" |
  "E_EPOCH" | "E_ASSERTION" | "E_ZK" | "E_NULLIFIER" | "E_RSSI";
export class ObservationPolicyError extends Error {
  readonly code: ObservationPolicyCode | "observation_dependency_unavailable" | "observation_capacity";
  constructor(code: ObservationPolicyError["code"]) { super(code); this.code = code; }
}
export interface ValidatedObservationReceipt {
  status: "validated"; transcript_hash: string; policy_validated: true;
}
/** Implementations must authenticate account owners, PDA addresses and their configured cluster/program. */
export interface ObservationPolicySource {
  readonly target: string;
  readonly paymentScope?: string;
  observationStatus?(payload: ObservationRelayPayload): Promise<ObservationChainStatus>;
  payout?(pseudonym: string): Promise<Record<string, unknown>>;
  claim?(pseudonym: string, withdrawalKey: string, destination: string, expiresAt?: string): Promise<ClaimAuthorization>;
  prepareClaim?(authorization: ClaimAuthorization, verifier: string, signature: string): Promise<{ message: string; blockhash: string; lastValidBlockHeight: number }>;
  snapshot(transcript: ObservationTranscript): Promise<{
    device: { key: Uint8Array; curve: number; capabilities: number } | undefined;
    epochSeconds: number;
    minimumRSSI: number;
    roots: string[];
    nullifierUsed: boolean;
    verifier?: string;
    policyVersion?: number;
  }>;
}
export interface ObservationProofVerifier {
  verify(envelope: ObservationEnvelope): Promise<boolean>;
}

/** Spec §2.3: BE wire integers, unlike the LE Borsh transcript. Ed25519 signs SHA-256(message). */
export function deviceChallengeDigest(t: ObservationTranscript, challenge: TranscriptChallenge): Buffer {
  const epoch = Buffer.alloc(4); epoch.writeUInt32BE(t.epoch);
  const time = Buffer.alloc(8); time.writeBigUInt64BE(challenge.deviceTimestamp);
  const counter = Buffer.alloc(4); counter.writeUInt32BE(challenge.deviceCounter);
  return createHash("sha256").update("Pathnod/challenge/v0", "ascii").update(challenge.nonce)
    .update(epoch).update(t.pseudonym.subarray(0, 8)).update(time).update(counter).update(t.evidenceHash).digest();
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function reject(code: ObservationPolicyCode): never { throw new ObservationPolicyError(code); }

/** Uses the SAME file as AppAttestGate/ObserverEnrollmentService, so final counter CAS and receipt are atomic. */
export class ObservationPolicyService {
  readonly #db: DatabaseSync;
  readonly #attest: AppAttestVerifier;
  readonly #source: ObservationPolicySource;
  readonly #proof: ObservationProofVerifier;
  readonly #clock: () => number;
  readonly #capacity: number;
  readonly #relay: { signer: ObservationSigner; capacity: number } | undefined;
  constructor(databasePath: string, policy: AppAttestPolicy, source: ObservationPolicySource,
    proof: ObservationProofVerifier, options: { clock?: () => number; capacity?: number;
      relay?: { signer: ObservationSigner; capacity?: number } } = {}) {
    this.#capacity = options.capacity ?? 100_000;
    if (!source.target || !Number.isInteger(this.#capacity) || this.#capacity < 1 || this.#capacity > 1_000_000) {
      throw Error("Invalid observation policy configuration");
    }
    this.#source = source; this.#proof = proof; this.#clock = options.clock ?? Date.now;
    this.#attest = new AppAttestVerifier(policy); this.#db = new DatabaseSync(databasePath);
    this.#relay = options.relay ? { signer: options.relay.signer, capacity: options.relay.capacity ?? this.#capacity } : undefined;
    if (this.#relay && (!Number.isInteger(this.#relay.capacity) || this.#relay.capacity < 1 || this.#relay.capacity > 1_000_000)) {
      this.#db.close(); throw Error("Invalid relay capacity");
    }
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS observation_policy_target (id INTEGER PRIMARY KEY CHECK(id=1), target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_validations_v0 (
        transcript_hash TEXT PRIMARY KEY, envelope_hash TEXT NOT NULL, nullifier TEXT NOT NULL UNIQUE, validated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_device_counters_v0 (device_id TEXT PRIMARY KEY, counter INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observer_revocations_v0 (key_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_payout_owners_v0 (
        protocol TEXT NOT NULL, pseudonym TEXT NOT NULL, key_id TEXT NOT NULL,
        PRIMARY KEY(protocol, pseudonym));
    `);
    this.#db.prepare("INSERT OR IGNORE INTO observation_policy_target VALUES (1, ?)").run(source.target);
    if (this.#db.prepare("SELECT target FROM observation_policy_target WHERE id=1").get()?.target !== source.target) {
      this.#db.close(); throw Error("Observation database belongs to another chain/program/policy target");
    }
    // Fail startup if not connected to the real enrollment database.
    try {
      this.#db.prepare("SELECT key_id FROM observer_enrollments LIMIT 1").get();
      this.#db.prepare("SELECT key_id FROM app_attest_keys LIMIT 1").get();
    } catch (error) { this.#db.close(); throw error; }
    if (this.#relay) {
      try { initializeObservationRelay(this.#db, source.target, this.#relay.signer.publicKey); }
      catch (error) { this.#db.close(); throw error; }
    }
  }
  close(): void { this.#db.close(); }
  async observationStatus(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid observation hash');
    if (!this.#source.observationStatus) throw new ObservationPolicyError('observation_dependency_unavailable');
    const row = this.#db.prepare('SELECT status, signature, payload FROM observation_relay_jobs WHERE transcript_hash=?').get(hash);
    if (!row) return undefined;
    try {
      const payload = JSON.parse(String(row.payload)) as ObservationRelayPayload;
      if (payload.transcriptHash !== hash) throw Error('Corrupt observation status record');
      const chain = await this.#source.observationStatus(payload);
      const replay = this.#db.prepare("SELECT name FROM sqlite_master WHERE name='gate2_replays_v0'").get()
        ? this.#db.prepare('SELECT signature,error_code,unchanged FROM gate2_replays_v0 WHERE transcript_hash=?').get(hash) : undefined;
      return { ...chain, transcript_hash: hash, status: chain.on_chain ? 'finalized' : String(row.status),
        transaction_signature: chain.on_chain && row.status === 'confirmed' ? row.signature : null,
        duplicate: chain.on_chain && replay?.error_code === 6001 && replay.unchanged === 1
          ? {status:'rejected',error:'E_NULLIFIER',unchanged:true,transaction_signature:replay.signature} : null };
    } catch { throw new ObservationPolicyError('observation_dependency_unavailable'); }
  }
  async payout(pseudonym: string) {
    if (!this.#source.payout) throw new ObservationPolicyError('observation_dependency_unavailable');
    return this.#source.payout(pseudonym);
  }
  async authorizeClaim(input: { pseudonym: string; withdrawal_key: string; destination: string; key_id: string; assertion: string; expires_at: string }) {
    if (!this.#relay || !this.#source.claim) throw new ObservationPolicyError('observation_dependency_unavailable');
    const authorization = await this.#source.claim(input.pseudonym, input.withdrawal_key, input.destination, input.expires_at);
    const key = this.#key(input.key_id);
    if (!key) reject('E_ASSERTION');
    // The relationship was established ONLY after an attested, ZK-verified observation.
    const owner = this.#db.prepare('SELECT key_id FROM observation_payout_owners_v0 WHERE pseudonym=? AND protocol=?')
      .get(input.pseudonym, this.#source.paymentScope ?? this.#source.target);
    if (owner?.key_id !== input.key_id || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.assertion)
        || input.assertion.length > 16384) reject('E_ASSERTION');
    let asserted: VerifiedAppAttestKey;
    try { asserted = this.#attest.verifyAssertion({ key, object: Buffer.from(input.assertion, 'base64'),
      expectedChallenge: claimDigest(authorization), challengeIsClientDataHash: true }); }
    catch { reject('E_ASSERTION'); }
    let signature: string;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#key(input.key_id);
      if (!current || current.counter !== key.counter || current.publicKeyPem !== key.publicKeyPem) reject('E_ASSERTION');
      const changed = this.#db.prepare('UPDATE app_attest_keys SET counter=?, bundle_version=? WHERE key_id=? AND counter=?')
        .run(asserted.counter, asserted.bundleVersion ?? null, input.key_id, key.counter);
      if (changed.changes !== 1) reject('E_ASSERTION');
      signature = this.#relay.signer.signClaimDigest(claimDigest(authorization));
      this.#db.exec('COMMIT');
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    const prepared = await this.#source.prepareClaim?.(authorization,this.#relay.signer.publicKey,signature);
    return { authorization, verifier: this.#relay.signer.publicKey, signature, ...prepared };
  }
  async claimQuote(pseudonym: string, withdrawalKey: string, destination: string) {
    if (!this.#source.claim) throw new ObservationPolicyError('observation_dependency_unavailable');
    return this.#source.claim(pseudonym, withdrawalKey, destination);
  }
  relayStatus(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid transcript hash");
    if (!this.#relay) return undefined;
    const row = this.#db.prepare("SELECT status, signature, last_error FROM observation_relay_jobs WHERE transcript_hash=?").get(hash);
    return row ? { status: row.status, transaction_signature: row.signature, error: row.last_error,
      on_chain: row.status === "confirmed", paid: null } : undefined;
  }
  revoke(keyID: string): void {
    this.#db.prepare("INSERT OR IGNORE INTO observer_revocations_v0 VALUES (?, ?)").run(keyID, this.#clock());
  }
  #key(keyID: string): VerifiedAppAttestKey | undefined {
    const row = this.#db.prepare(`SELECT k.* FROM app_attest_keys k JOIN observer_enrollments e USING(key_id)
      LEFT JOIN observer_revocations_v0 r USING(key_id) WHERE k.key_id=? AND e.observer_class=1 AND r.key_id IS NULL`).get(keyID);
    if (!row || (row.environment !== "development" && row.environment !== "production")) return undefined;
    return { keyID, publicKeyPem: String(row.public_key_pem), appID: String(row.app_id), environment: row.environment,
      counter: Number(row.counter), ...(row.validation_category === null ? {} : { validationCategory: Number(row.validation_category) }),
      ...(row.bundle_version === null ? {} : { bundleVersion: String(row.bundle_version) }) };
  }
  #previous(hash: string, digest: string): ValidatedObservationReceipt | undefined {
    const row = this.#db.prepare("SELECT envelope_hash FROM observation_validations_v0 WHERE transcript_hash=?").get(hash);
    if (!row) return undefined;
    if (row.envelope_hash !== digest) reject("E_NULLIFIER");
    return { status: "validated", transcript_hash: hash, policy_validated: true };
  }
  #counter(device: string): number {
    return Number(this.#db.prepare("SELECT counter FROM observation_device_counters_v0 WHERE device_id=?").get(device)?.counter ?? -1);
  }
  #checkCounters(t: ObservationTranscript, device: string): void {
    let previous = this.#counter(device);
    for (const c of t.challenges) { if (c.deviceCounter <= previous) reject("E_DEV_COUNTER"); previous = c.deviceCounter; }
  }
  #checkTime(t: ObservationTranscript, epochSeconds: number): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(epochSeconds) || epochSeconds < 1 || epochSeconds > 0xffff_ffff) {
      throw new ObservationPolicyError("observation_dependency_unavailable");
    }
    if (t.observationTimeMilliseconds < BigInt(now) - 600_000n || t.observationTimeMilliseconds > BigInt(now) + 600_000n ||
      BigInt(t.epoch) !== t.observationTimeMilliseconds / (BigInt(epochSeconds) * 1000n)) reject("E_EPOCH");
    return now;
  }
  async receive(input: unknown): Promise<ValidatedObservationReceipt> {
    const { envelope, hash, publicInputsMatch } = await parseObservationEnvelope(input, true);
    const digest = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
    // Historical idempotent receipt, NOT a new authorization or a fresh chain check.
    const previous = this.#previous(hash, digest); if (previous) return previous;
    const t = decodeObservationTranscript(Buffer.from(envelope.transcript, "base64"), 0);
    let snapshot: Awaited<ReturnType<ObservationPolicySource["snapshot"]>>;
    try { snapshot = await this.#source.snapshot(t); }
    catch (error) {
      if (error instanceof ObservationPolicyError) throw error;
      throw new ObservationPolicyError("observation_dependency_unavailable");
    }
    const receivedDuringRead = this.#previous(hash, digest); if (receivedDuringRead) return receivedDuringRead;
    const device = Buffer.from(t.deviceID).toString("hex");
    if (!snapshot.device || snapshot.device.curve !== t.curve ||
      !Buffer.from(snapshot.device.key).equals(t.publicKey) ||
      !createHash("sha256").update("Pathnod/device/v0").update(t.publicKey).digest().equals(t.deviceID)) reject("E_DEVICE_UNKNOWN");
    // Only the current Ed25519 device flow is supported. Never accept an unimplemented curve.
    try {
      if (t.curve !== 1) reject("E_DEV_SIG");
      const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(t.publicKey)]), format: "der", type: "spki" });
      for (const c of t.challenges) if (!verify(null, deviceChallengeDigest(t, c), key, c.signature)) reject("E_DEV_SIG");
    } catch { reject("E_DEV_SIG"); }
    const counterEnabled = (snapshot.device.capabilities & 2) !== 0;
    if (counterEnabled) this.#checkCounters(t, device);
    if (median(t.challenges.map(c => c.roundTripMilliseconds)) > 400) reject("E_RTT");
    if (!Number.isInteger(snapshot.minimumRSSI) || snapshot.minimumRSSI < -127 || snapshot.minimumRSSI > 0) {
      throw new ObservationPolicyError("observation_dependency_unavailable");
    }
    this.#checkTime(t, snapshot.epochSeconds);
    const key = this.#key(envelope.key_id);
    if (!key || t.observerClass !== 1) reject("E_ASSERTION");
    let asserted: VerifiedAppAttestKey;
    try {
      asserted = this.#attest.verifyAssertion({ key, object: Buffer.from(envelope.assertion, "base64"),
        expectedChallenge: Buffer.from(hash, "hex"), challengeIsClientDataHash: true });
    } catch { reject("E_ASSERTION"); }
    if (!publicInputsMatch || snapshot.roots.length > 4 || !snapshot.roots.includes(envelope.zk.public[0]!)) reject("E_ZK");
    let valid: boolean;
    try { valid = await this.#proof.verify(envelope); }
    catch { throw new ObservationPolicyError("observation_dependency_unavailable"); }
    const receivedDuringProof = this.#previous(hash, digest); if (receivedDuringProof) return receivedDuringProof;
    if (!valid) reject("E_ZK");
    const nullifier = Buffer.from(t.nullifier).toString("hex");
    if (snapshot.nullifierUsed || this.#db.prepare("SELECT 1 FROM observation_validations_v0 WHERE nullifier=?").get(nullifier)) reject("E_NULLIFIER");
    if (t.local.rssiSamples.length < 5 || median(t.local.rssiSamples) < snapshot.minimumRSSI) reject("E_RSSI");
    const now = this.#checkTime(t, snapshot.epochSeconds);
    let relayPayload: ObservationRelayPayload | undefined;
    if (this.#relay) {
      if (snapshot.verifier !== this.#relay.signer.publicKey || !Number.isInteger(snapshot.policyVersion) ||
          snapshot.policyVersion! < 1 || snapshot.policyVersion! > 0xffff_ffff) {
        throw new ObservationPolicyError("observation_dependency_unavailable");
      }
      const authorization = { transcriptHash: hash, nullifier, pseudonym: Buffer.from(t.pseudonym).toString("hex"),
        observerClass: t.observerClass, policyVersion: snapshot.policyVersion! };
      relayPayload = { ...authorization, protocolID: Buffer.from(t.protocolID).toString("hex"), deviceID: device,
        evidenceHash: Buffer.from(t.evidenceHash).toString("hex"), epoch: t.epoch,
        proofBytes: relayProofBytes(envelope.zk.proof, envelope.zk.public).toString("hex"),
        verifier: this.#relay.signer.publicKey, verifierSignature: "" };
    }
    // No await inside the transaction. CAS also observes concurrent enrollment/tree assertions.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.#previous(hash, digest);
      if (raced) { this.#db.exec("COMMIT"); return raced; }
      if (this.#db.prepare("SELECT 1 FROM observation_validations_v0 WHERE nullifier=?").get(nullifier)) reject("E_NULLIFIER");
      const current = this.#key(envelope.key_id);
      if (!current || current.counter !== key.counter || current.publicKeyPem !== key.publicKeyPem) reject("E_ASSERTION");
      if (counterEnabled) this.#checkCounters(t, device);
      if (Number(this.#db.prepare("SELECT COUNT(*) AS n FROM observation_validations_v0").get()!.n) >= this.#capacity) {
        throw new ObservationPolicyError("observation_capacity");
      }
      if (this.#relay && Number(this.#db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!.n) >= this.#relay.capacity) {
        throw new ObservationPolicyError("observation_capacity");
      }
      const changed = this.#db.prepare("UPDATE app_attest_keys SET counter=?, bundle_version=? WHERE key_id=? AND counter=?")
        .run(asserted.counter, asserted.bundleVersion ?? null, envelope.key_id, key.counter);
      if (changed.changes !== 1) reject("E_ASSERTION");
      if (counterEnabled) this.#db.prepare(`INSERT INTO observation_device_counters_v0 VALUES (?, ?)
        ON CONFLICT(device_id) DO UPDATE SET counter=excluded.counter`).run(device, t.challenges[2]!.deviceCounter);
      this.#db.prepare("INSERT INTO observation_validations_v0 VALUES (?, ?, ?, ?)").run(hash, digest, nullifier, now);
      const pseudonym = Buffer.from(t.pseudonym).toString('hex');
      const owner = this.#db.prepare('SELECT key_id FROM observation_payout_owners_v0 WHERE protocol=? AND pseudonym=?')
        .get(this.#source.paymentScope ?? this.#source.target, pseudonym);
      if (owner && owner.key_id !== envelope.key_id) reject('E_ASSERTION');
      this.#db.prepare('INSERT OR IGNORE INTO observation_payout_owners_v0 VALUES (?, ?, ?)')
        .run(this.#source.paymentScope ?? this.#source.target, pseudonym, envelope.key_id);
      if (relayPayload) {
        relayPayload.verifierSignature = this.#relay!.signer.sign(relayPayload);
        queueValidatedObservation(this.#db, relayPayload, this.#relay!.capacity);
      }
      this.#db.exec("COMMIT");
    } catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw error; }
    return { status: "validated", transcript_hash: hash, policy_validated: true };
  }
}
