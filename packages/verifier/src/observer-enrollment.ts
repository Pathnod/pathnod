import { DatabaseSync } from "node:sqlite";

import { buildPoseidon } from "circomlibjs";

import type { AppAttestChallengePurpose, IssuedAppAttestChallenge } from "./app-attest-gate.ts";
import { AppAttestVerificationError, type VerifiedAppAttestKey } from "./app-attest.ts";

const MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DEPTH = 20;
const CLASS = 1;

export type EnrollmentErrorCode =
  | "invalid_input" | "unknown_observer" | "already_enrolled" | "invalid_challenge"
  | "invalid_attestation" | "tree_full" | "challenge_limit";

export class EnrollmentError extends Error {
  readonly code: EnrollmentErrorCode;
  readonly reason?: string;
  constructor(code: EnrollmentErrorCode, reason?: string) {
    super(`Observer enrollment failed: ${code}.`);
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

export interface EnrollmentAttestationGate {
  issueChallenge(purpose: AppAttestChallengePurpose, keyID?: string): IssuedAppAttestChallenge;
  acceptAttestation(challengeID: string, keyID: string, object: Uint8Array): VerifiedAppAttestKey;
  acceptAssertion(challengeID: string, keyID: string, object: Uint8Array): VerifiedAppAttestKey;
  getKey(keyID: string): VerifiedAppAttestKey | undefined;
  purgeExpiredChallenges?(): void;
  discardChallenge?(id: string): void;
}

export interface EnrollmentChallenge {
  readonly id: string;
  readonly bytes: Buffer;
  readonly mode: "attestation" | "assertion";
  readonly expiresAt: number;
}

export interface MerklePath {
  readonly commitment: string;
  readonly observerClass: number;
  readonly leaf: string;
  readonly leafIndex: number;
  readonly siblings: string[];
  readonly directions: number[];
  readonly root: string;
  readonly rootRevision: number;
}

interface ChallengeRow {
  id: string;
  operation: string;
  commitment: string;
  key_id: string;
  mode: string;
  expires_at: number;
}

interface EnrollmentRow {
  key_id: string;
  commitment: string;
  observer_class: number;
  leaf_index: number;
  leaf: string;
}

function field(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new EnrollmentError("invalid_input");
  }
  const parsed = BigInt(value);
  if (parsed >= MODULUS) throw new EnrollmentError("invalid_input");
  return parsed;
}

function hex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function keyID(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new EnrollmentError("invalid_input");
  }
  if (Buffer.from(value, "base64").toString("base64") !== value) {
    throw new EnrollmentError("invalid_input");
  }
  return value;
}

export class ObserverEnrollmentService {
  readonly #database: DatabaseSync;
  readonly #gate: EnrollmentAttestationGate;
  readonly #poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  readonly #empty: string[];
  readonly #maxPending: number;

  private constructor(databasePath: string, gate: EnrollmentAttestationGate,
    poseidon: Awaited<ReturnType<typeof buildPoseidon>>, maxPending: number) {
    this.#maxPending = maxPending;
    this.#gate = gate;
    this.#poseidon = poseidon;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS observer_enrollments (
        key_id TEXT PRIMARY KEY,
        commitment TEXT NOT NULL UNIQUE,
        observer_class INTEGER NOT NULL CHECK (observer_class BETWEEN 1 AND 3),
        leaf_index INTEGER NOT NULL UNIQUE,
        leaf TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observer_challenges (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK (operation IN ('enroll', 'tree')),
        commitment TEXT NOT NULL,
        key_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('attestation', 'assertion')),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observer_merkle_nodes (
        level INTEGER NOT NULL,
        node_index INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (level, node_index)
      );
      CREATE TABLE IF NOT EXISTS observer_roots (
        revision INTEGER PRIMARY KEY,
        root TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observer_enrollment_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id TEXT NOT NULL,
        commitment TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('enrolled', 'reenrolled')),
        root_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observer_challenge_expiry ON observer_challenges(expires_at);
    `);
    this.#empty = [hex(0n)];
    for (let level = 0; level < DEPTH; level++) {
      const previous = field(this.#empty[level]);
      this.#empty.push(hex(this.#hash(previous, previous)));
    }
    this.#database.prepare(
      "INSERT OR IGNORE INTO observer_roots (revision, root, created_at) VALUES (0, ?, ?)",
    ).run(this.#empty[DEPTH]!, Date.now());
  }

  static async open(databasePath: string, gate: EnrollmentAttestationGate,
    options: { maxPendingChallenges?: number } = {}): Promise<ObserverEnrollmentService> {
    const limit = options.maxPendingChallenges ?? 1024;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new EnrollmentError("invalid_input");
    if (typeof databasePath !== "string" || databasePath.length === 0) {
      throw new EnrollmentError("invalid_input");
    }
    return new ObserverEnrollmentService(databasePath, gate, await buildPoseidon(), limit);
  }

  close(): void { this.#database.close(); }

  issueEnrollmentChallenge(commitmentValue: unknown, keyValue: unknown): EnrollmentChallenge {
    const commitment = hex(field(commitmentValue));
    const id = keyID(keyValue);
    const record = this.#enrollment(id);
    if (record !== undefined && record.commitment !== commitment) throw new EnrollmentError("already_enrolled");
    const owner = this.#database.prepare("SELECT key_id FROM observer_enrollments WHERE commitment = ?")
      .get(commitment) as { key_id: string } | undefined;
    if (owner !== undefined && owner.key_id !== id) throw new EnrollmentError("already_enrolled");
    const mode = this.#gate.getKey(id) === undefined ? "attestation" : "assertion";
    return this.#issue("enroll", commitment, id, mode);
  }

  enroll(challengeID: unknown, commitmentValue: unknown, keyValue: unknown, object: Uint8Array): MerklePath {
    const commitment = hex(field(commitmentValue));
    const id = keyID(keyValue);
    const challenge = this.#consume(challengeID, "enroll", commitment, id);
    try {
      if (challenge.mode === "attestation") {
        this.#gate.acceptAttestation(challenge.id, id, object);
      } else {
        this.#gate.acceptAssertion(challenge.id, id, object);
      }
    } catch (error) {
      throw new EnrollmentError("invalid_attestation", error instanceof AppAttestVerificationError
        ? [error.code, error.detail].filter(Boolean).join(".") : undefined);
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      let record = this.#enrollment(id);
      let action: "enrolled" | "reenrolled";
      if (record === undefined) {
        const existing = this.#database.prepare("SELECT key_id FROM observer_enrollments WHERE commitment = ?")
          .get(commitment);
        if (existing !== undefined) throw new EnrollmentError("already_enrolled");
        const row = this.#database.prepare("SELECT MAX(leaf_index) AS last_index FROM observer_enrollments")
          .get() as { last_index: number | null };
        const leafIndex = (row.last_index ?? -1) + 1;
        if (leafIndex >= 2 ** DEPTH) throw new EnrollmentError("tree_full");
        const leaf = hex(this.#hash(field(commitment), BigInt(CLASS)));
        this.#database.prepare(`
          INSERT INTO observer_enrollments (key_id, commitment, observer_class, leaf_index, leaf)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, commitment, CLASS, leafIndex, leaf);
        this.#updateTree(leafIndex, leaf);
        record = { key_id: id, commitment, observer_class: CLASS, leaf_index: leafIndex, leaf };
        action = "enrolled";
      } else {
        if (record.commitment !== commitment) throw new EnrollmentError("already_enrolled");
        action = "reenrolled";
      }
      const revision = this.#rootState().revision;
      this.#database.prepare(`
        INSERT INTO observer_enrollment_events (key_id, commitment, action, root_revision, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, commitment, action, revision, Date.now());
      const path = this.#path(record);
      this.#database.exec("COMMIT");
      return path;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  issueTreeChallenge(commitmentValue: unknown, keyValue: unknown): EnrollmentChallenge {
    const commitment = hex(field(commitmentValue));
    const id = keyID(keyValue);
    if (this.#enrollment(id)?.commitment !== commitment) throw new EnrollmentError("unknown_observer");
    return this.#issue("tree", commitment, id, "assertion");
  }

  treePath(challengeID: unknown, commitmentValue: unknown, keyValue: unknown, object: Uint8Array): MerklePath {
    const commitment = hex(field(commitmentValue));
    const id = keyID(keyValue);
    const challenge = this.#consume(challengeID, "tree", commitment, id);
    try {
      this.#gate.acceptAssertion(challenge.id, id, object);
    } catch (error) {
      throw new EnrollmentError("invalid_attestation", error instanceof AppAttestVerificationError
        ? [error.code, error.detail].filter(Boolean).join(".") : undefined);
    }
    const record = this.#enrollment(id);
    if (record?.commitment !== commitment) throw new EnrollmentError("unknown_observer");
    return this.#path(record);
  }

  root(): { root: string; revision: number } { return this.#rootState(); }

  #hash(...inputs: bigint[]): bigint {
    return this.#poseidon.F.toObject(this.#poseidon(inputs));
  }

  #enrollment(id: string): EnrollmentRow | undefined {
    return this.#database.prepare("SELECT * FROM observer_enrollments WHERE key_id = ?")
      .get(id) as EnrollmentRow | undefined;
  }

  #issue(operation: "enroll" | "tree", commitment: string, id: string,
    mode: "attestation" | "assertion"): EnrollmentChallenge {
    this.#gate.purgeExpiredChallenges?.();
    this.#database.prepare("DELETE FROM observer_challenges WHERE expires_at <= ?").run(Date.now());
    const checkCapacity = () => {
      const pending = this.#database.prepare("SELECT COUNT(*) AS n FROM observer_challenges").get() as { n: number };
      if (pending.n >= this.#maxPending) throw new EnrollmentError("challenge_limit");
    };
    checkCapacity();
    let issued: IssuedAppAttestChallenge;
    try { issued = this.#gate.issueChallenge(mode, mode === "assertion" ? id : undefined); }
    catch (error) {
      if (error instanceof AppAttestVerificationError && error.code === "challenge_limit") throw new EnrollmentError("challenge_limit");
      throw error;
    }
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      checkCapacity();
      this.#database.prepare(`
        INSERT INTO observer_challenges (id, operation, commitment, key_id, mode, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(issued.id, operation, commitment, id, mode, issued.expiresAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      this.#gate.discardChallenge?.(issued.id);
      throw error;
    }
    return { ...issued, mode };
  }

  #consume(challengeID: unknown, operation: "enroll" | "tree", commitment: string,
    id: string): ChallengeRow {
    if (typeof challengeID !== "string" || challengeID.length === 0) {
      throw new EnrollmentError("invalid_challenge");
    }
    this.#gate.purgeExpiredChallenges?.();
    this.#database.prepare("DELETE FROM observer_challenges WHERE expires_at <= ?").run(Date.now());
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare("SELECT * FROM observer_challenges WHERE id = ?")
        .get(challengeID) as ChallengeRow | undefined;
      this.#database.prepare("DELETE FROM observer_challenges WHERE id = ?").run(challengeID);
      this.#database.exec("COMMIT");
      if (row === undefined || row.operation !== operation || row.commitment !== commitment ||
          row.key_id !== id || row.expires_at <= Date.now()) {
        if (row !== undefined) this.#gate.discardChallenge?.(row.id);
        throw new EnrollmentError("invalid_challenge");
      }
      return row;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #node(level: number, index: number): string {
    const row = this.#database.prepare(
      "SELECT value FROM observer_merkle_nodes WHERE level = ? AND node_index = ?",
    ).get(level, index) as { value: string } | undefined;
    return row?.value ?? this.#empty[level]!;
  }

  #updateTree(leafIndex: number, leaf: string): void {
    let index = leafIndex;
    let current = leaf;
    for (let level = 0; level < DEPTH; level++) {
      this.#database.prepare(`
        INSERT INTO observer_merkle_nodes (level, node_index, value) VALUES (?, ?, ?)
        ON CONFLICT(level, node_index) DO UPDATE SET value = excluded.value
      `).run(level, index, current);
      const sibling = this.#node(level, index ^ 1);
      const left = index % 2 === 0 ? current : sibling;
      const right = index % 2 === 0 ? sibling : current;
      current = hex(this.#hash(field(left), field(right)));
      index = Math.floor(index / 2);
    }
    this.#database.prepare(`
      INSERT INTO observer_merkle_nodes (level, node_index, value) VALUES (?, 0, ?)
      ON CONFLICT(level, node_index) DO UPDATE SET value = excluded.value
    `).run(DEPTH, current);
    const revision = this.#rootState().revision + 1;
    this.#database.prepare("INSERT INTO observer_roots (revision, root, created_at) VALUES (?, ?, ?)")
      .run(revision, current, Date.now());
  }

  #rootState(): { root: string; revision: number } {
    const row = this.#database.prepare(
      "SELECT revision, root FROM observer_roots ORDER BY revision DESC LIMIT 1",
    ).get() as { revision: number; root: string };
    return row;
  }

  #path(record: EnrollmentRow): MerklePath {
    let index = record.leaf_index;
    const siblings: string[] = [];
    const directions: number[] = [];
    for (let level = 0; level < DEPTH; level++) {
      siblings.push(this.#node(level, index ^ 1));
      directions.push(index & 1);
      index = Math.floor(index / 2);
    }
    const { root, revision } = this.#rootState();
    return {
      commitment: record.commitment, observerClass: record.observer_class,
      leaf: record.leaf, leafIndex: record.leaf_index,
      siblings, directions, root, rootRevision: revision,
    };
  }
}
