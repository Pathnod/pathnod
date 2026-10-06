import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { AppAttestVerifier, AppAttestVerificationError } from "./app-attest.ts";
import type { AppAttestPolicy, VerifiedAppAttestKey } from "./app-attest.ts";

export type AppAttestChallengePurpose = "attestation" | "assertion";

export interface IssuedAppAttestChallenge {
  readonly id: string;
  readonly bytes: Buffer;
  readonly expiresAt: number;
}

export interface IssuedAppAttestTrial {
  readonly session: string;
  readonly attestation: IssuedAppAttestChallenge;
  readonly firstAssertion: IssuedAppAttestChallenge;
  readonly secondAssertion: IssuedAppAttestChallenge;
}

interface ChallengeRow {
  id: string;
  purpose: string;
  key_id: string | null;
  trial_id: string | null;
  bytes: Buffer;
  expires_at: number;
}

interface KeyRow {
  key_id: string;
  public_key_pem: string;
  app_id: string;
  environment: string;
  counter: number;
  validation_category: number | null;
  bundle_version: string | null;
}

export class AppAttestGate {
  readonly #database: DatabaseSync;
  readonly #verifier: AppAttestVerifier;
  readonly #maxPending: number;

  constructor(databasePath: string, policy: AppAttestPolicy, options: { maxPendingChallenges?: number } = {}) {
    this.#maxPending = options.maxPendingChallenges ?? 1024;
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 1 || this.#maxPending > 100_000) {
      throw new AppAttestVerificationError("invalid_input");
    }
    if (typeof databasePath !== "string" || databasePath.length === 0) {
      throw new AppAttestVerificationError("invalid_input");
    }
    this.#verifier = new AppAttestVerifier(policy);
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS app_attest_challenges (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('attestation', 'assertion')),
        key_id TEXT,
        trial_id TEXT,
        bytes BLOB NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_attest_keys (
        key_id TEXT PRIMARY KEY,
        public_key_pem TEXT NOT NULL,
        app_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        counter INTEGER NOT NULL,
        validation_category INTEGER,
        bundle_version TEXT
      );
      CREATE INDEX IF NOT EXISTS app_attest_challenge_expiry ON app_attest_challenges(expires_at);
    `);
  }

  close(): void {
    this.#database.close();
  }

  purgeExpiredChallenges(): void {
    this.#database.prepare("DELETE FROM app_attest_challenges WHERE expires_at <= ?").run(Date.now());
  }

  discardChallenge(id: string): void {
    this.#database.prepare("DELETE FROM app_attest_challenges WHERE id = ?").run(id);
  }

  #reserve(count: number): void {
    this.purgeExpiredChallenges();
    const pending = this.#database.prepare("SELECT COUNT(*) AS n FROM app_attest_challenges").get() as { n: number };
    if (pending.n + count > this.#maxPending) throw new AppAttestVerificationError("challenge_limit");
  }

  issueChallenge(purpose: AppAttestChallengePurpose, keyID?: string): IssuedAppAttestChallenge {
    if ((purpose !== "attestation" && purpose !== "assertion") ||
        (purpose === "assertion" && (typeof keyID !== "string" || keyID.length === 0)) ||
        (purpose === "attestation" && keyID !== undefined)) {
      throw new AppAttestVerificationError("invalid_input");
    }
    if (purpose === "assertion" && this.getKey(keyID!) === undefined) {
      throw new AppAttestVerificationError("invalid_key");
    }
    this.purgeExpiredChallenges();
    const issued = { id: randomUUID(), bytes: randomBytes(32), expiresAt: Date.now() + 5 * 60_000 };
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#reserve(1);
      this.#database.prepare(
        "INSERT INTO app_attest_challenges (id, purpose, key_id, bytes, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(issued.id, purpose, keyID ?? null, issued.bytes, issued.expiresAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
    return issued;
  }

  issueTrial(): IssuedAppAttestTrial {
    this.purgeExpiredChallenges();
    const session = randomUUID();
    const create = (): IssuedAppAttestChallenge => ({
      id: randomUUID(), bytes: randomBytes(32), expiresAt: Date.now() + 5 * 60_000,
    });
    const attestation = create();
    const firstAssertion = create();
    const secondAssertion = create();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#reserve(3);
      const insert = this.#database.prepare(
        "INSERT INTO app_attest_challenges (id, purpose, key_id, trial_id, bytes, expires_at) VALUES (?, ?, NULL, ?, ?, ?)",
      );
      insert.run(attestation.id, "attestation", session, attestation.bytes, attestation.expiresAt);
      insert.run(firstAssertion.id, "assertion", session, firstAssertion.bytes, firstAssertion.expiresAt);
      insert.run(secondAssertion.id, "assertion", session, secondAssertion.bytes, secondAssertion.expiresAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
    return { session, attestation, firstAssertion, secondAssertion };
  }

  acceptAttestation(challengeID: string, keyID: string, object: Uint8Array): VerifiedAppAttestKey {
    const challenge = this.#consumeChallenge(challengeID, "attestation", null);
    const verified = this.#verifier.verifyAttestation({ keyID, object, expectedChallenge: challenge.bytes });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO app_attest_keys
        (key_id, public_key_pem, app_id, environment, counter, validation_category, bundle_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        verified.keyID, verified.publicKeyPem, verified.appID, verified.environment,
        verified.counter, verified.validationCategory ?? null, verified.bundleVersion ?? null,
      );
      this.#database.prepare(
        "UPDATE app_attest_challenges SET key_id = ? WHERE trial_id = ? AND purpose = 'assertion'",
      ).run(verified.keyID, challenge.trial_id);
      this.#database.exec("COMMIT");
    } catch {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw new AppAttestVerificationError("invalid_key");
    }
    return verified;
  }

  acceptAssertion(challengeID: string, keyID: string, object: Uint8Array): VerifiedAppAttestKey {
    const challenge = this.#consumeChallenge(challengeID, "assertion", keyID);
    const key = this.getKey(keyID);
    if (key === undefined) throw new AppAttestVerificationError("invalid_key");
    const verified = this.#verifier.verifyAssertion({ key, object, expectedChallenge: challenge.bytes });
    const update = this.#database.prepare(
      "UPDATE app_attest_keys SET counter = ?, bundle_version = ? WHERE key_id = ? AND counter = ?",
    ).run(verified.counter, verified.bundleVersion ?? null, keyID, key.counter);
    if (update.changes !== 1) throw new AppAttestVerificationError("invalid_counter");
    return verified;
  }

  getKey(keyID: string): VerifiedAppAttestKey | undefined {
    const row = this.#database.prepare("SELECT * FROM app_attest_keys WHERE key_id = ?").get(keyID) as KeyRow | undefined;
    if (row === undefined) return undefined;
    if (row.environment !== "development" && row.environment !== "production") {
      throw new AppAttestVerificationError("invalid_key");
    }
    return {
      keyID: row.key_id,
      publicKeyPem: row.public_key_pem,
      appID: row.app_id,
      environment: row.environment,
      counter: row.counter,
      ...(row.validation_category === null ? {} : { validationCategory: row.validation_category }),
      ...(row.bundle_version === null ? {} : { bundleVersion: row.bundle_version }),
    };
  }

  #consumeChallenge(id: string, purpose: AppAttestChallengePurpose, keyID: string | null): ChallengeRow {
    if (typeof id !== "string" || id.length === 0) throw new AppAttestVerificationError("invalid_input");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.purgeExpiredChallenges();
      const row = this.#database.prepare("SELECT * FROM app_attest_challenges WHERE id = ?").get(id) as ChallengeRow | undefined;
      this.#database.prepare("DELETE FROM app_attest_challenges WHERE id = ?").run(id);
      this.#database.exec("COMMIT");
      if (row === undefined || row.purpose !== purpose || row.key_id !== keyID || row.expires_at <= Date.now()) {
        throw new AppAttestVerificationError("invalid_input");
      }
      return row;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
