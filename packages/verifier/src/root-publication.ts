import { DatabaseSync } from "node:sqlite";
import type { ObserverRootSnapshot } from "./observer-enrollment.ts";

export type PublicationErrorCode = "invalid_config" | "invalid_target" | "invalid_authority" |
  "account_mismatch" | "rpc_error" | "storage_error";

export class RootPublicationError extends Error {
  readonly code: PublicationErrorCode;
  constructor(code: PublicationErrorCode) { super(`Root publication failed: ${code}`); this.code = code; }
}

export interface PreparedRootTransaction {
  readonly wire: string;
  readonly lastValidBlockHeight: number;
}

export interface RootPublicationTransport {
  readonly target: string;
  readonly program: string;
  readonly cluster: "devnet" | "local";
  inspect(snapshot: ObserverRootSnapshot): Promise<{ slot: number; active: boolean } | undefined>;
  prepare(snapshot: ObserverRootSnapshot): Promise<PreparedRootTransaction>;
  send(transaction: PreparedRootTransaction): Promise<string>;
  expired(transaction: PreparedRootTransaction): Promise<boolean>;
  address(root: string): string;
}

export interface RootPublicationSource {
  publicationBatch(afterRevision: number): { snapshot: ObserverRootSnapshot; oldestPendingAt: number } | undefined;
}

interface PublicationRow {
  revision: number;
  root: string;
  leaf_count: number;
  created_at: number;
  status: "pending" | "submitted" | "confirmed";
  wire: string | null;
  last_valid_height: number | null;
  signature: string | null;
  checked_slot: number | null;
  attempts: number;
  retry_at: number;
  last_error: PublicationErrorCode | null;
}

export class ObserverRootPublisher {
  readonly #db: DatabaseSync;
  readonly #source: RootPublicationSource;
  readonly #transport: RootPublicationTransport;
  readonly #batchSize: number;
  readonly #maxDelayMs: number;
  readonly #now: () => number;
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #backgroundError: PublicationErrorCode | null = null;
  #checked: { revision: number; active: boolean | null; at: number; slot: number | null; error: PublicationErrorCode | null } | undefined;

  constructor(databasePath: string, source: RootPublicationSource, transport: RootPublicationTransport,
    options: { batchSize?: number; maxDelayMs?: number; now?: () => number } = {}) {
    this.#batchSize = options.batchSize ?? 16;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 2 ** 20 ||
        !Number.isSafeInteger(this.#maxDelayMs) || this.#maxDelayMs < 1 || this.#maxDelayMs > 3_600_000) {
      throw new RootPublicationError("invalid_config");
    }
    this.#source = source;
    this.#transport = transport;
    this.#now = options.now ?? Date.now;
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS observer_publication_target (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), target TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observer_root_publications (
        revision INTEGER PRIMARY KEY, root TEXT NOT NULL, leaf_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','submitted','confirmed')),
        wire TEXT, last_valid_height INTEGER, signature TEXT, checked_slot INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `);
    this.#db.prepare("INSERT OR IGNORE INTO observer_publication_target VALUES (1, ?)").run(transport.target);
    const target = this.#db.prepare("SELECT target FROM observer_publication_target WHERE singleton = 1")
      .get() as { target: string };
    if (target.target !== transport.target) {
      this.#db.close();
      throw new RootPublicationError("invalid_target");
    }
  }

  start(): void {
    if (this.#closed) throw new RootPublicationError("invalid_config");
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => { void this.tick(); }, 1_000);
    this.#timer.unref();
    void this.tick();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#closed = true;
    this.#closing = (async () => { await this.#running; this.#db.close(); })();
    return this.#closing;
  }

  tick(force = false): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#running !== undefined) return this.#running;
    this.#backgroundError = null;
    this.#running = this.#publish(force).catch(error => {
      this.#backgroundError = error instanceof RootPublicationError ? error.code : "storage_error";
    }).finally(() => { this.#running = undefined; });
    return this.#running;
  }

  status() {
    const latest = this.#latest();
    const batch = this.#source.publicationBatch(latest?.revision ?? 0);
    const pending = this.#pending();
    return {
      enabled: true,
      state: pending?.last_error ? "retrying" : pending || batch ? "pending" : latest ?
        this.#checked?.active === true ? "confirmed" : this.#checked?.active === false ? "inactive" : "checking" : "empty",
      pendingRevision: batch?.snapshot.revision ?? pending?.revision ?? null,
      lastError: pending?.last_error ?? this.#checked?.error ?? this.#backgroundError,
      confirmed: latest ? {
        root: latest.root, revision: latest.revision, leafCount: latest.leaf_count,
        checkedAtSlot: this.#checked?.revision === latest.revision ? this.#checked.slot : null, signature: latest.signature,
        active: this.#checked?.revision === latest.revision ? this.#checked.active : null,
        lastCheckedAt: this.#checked?.revision === latest.revision ? this.#checked.at : null,
        address: this.#transport.address(latest.root),
        explorer: this.#transport.cluster === "devnet" ?
          `https://explorer.solana.com/address/${this.#transport.address(latest.root)}?cluster=devnet` : null,
      } : null,
    };
  }

  #latest(): PublicationRow | undefined {
    return this.#db.prepare("SELECT * FROM observer_root_publications WHERE status = 'confirmed' ORDER BY revision DESC LIMIT 1")
      .get() as PublicationRow | undefined;
  }

  #pending(): PublicationRow | undefined {
    return this.#db.prepare("SELECT * FROM observer_root_publications WHERE status != 'confirmed' ORDER BY revision LIMIT 1")
      .get() as PublicationRow | undefined;
  }

  async #publish(force: boolean): Promise<void> {
    const confirmed = this.#latest();
    if (confirmed && (!this.#checked || this.#now() - this.#checked.at >= 30_000)) {
      const snapshot = { root: confirmed.root, revision: confirmed.revision,
        leafCount: confirmed.leaf_count, createdAt: confirmed.created_at };
      try {
        const record = await this.#transport.inspect(snapshot);
        this.#checked = { revision: confirmed.revision, active: record?.active ?? false, at: this.#now(), slot: record?.slot ?? null, error: null };
      } catch (error) {
        this.#checked = { revision: confirmed.revision, active: null, at: this.#now(), slot: null,
          error: error instanceof RootPublicationError ? error.code : "rpc_error" };
      }
    }
    let row = this.#pending();
    if (!row) {
      const latest = this.#latest();
      const batch = this.#source.publicationBatch(latest?.revision ?? 0);
      if (!batch || (!force && batch.snapshot.leafCount - (latest?.leaf_count ?? 0) < this.#batchSize &&
          this.#now() - batch.oldestPendingAt < this.#maxDelayMs)) return;
      const snapshot = batch.snapshot;
      this.#db.prepare(`INSERT INTO observer_root_publications (revision,root,leaf_count,created_at,status)
        VALUES (?,?,?,?, 'pending')`).run(snapshot.revision, snapshot.root, snapshot.leafCount, snapshot.createdAt);
      row = this.#pending()!;
    }
    if (this.#now() < row.retry_at) return;
    const snapshot = { root: row.root, revision: row.revision, leafCount: row.leaf_count, createdAt: row.created_at };
    try {
      let inspected = await this.#transport.inspect(snapshot);
      if (!inspected) {
        let prepared = row.wire !== null && row.last_valid_height !== null ?
          { wire: row.wire, lastValidBlockHeight: row.last_valid_height } : undefined;
        if (prepared && await this.#transport.expired(prepared)) prepared = undefined;
        if (!prepared) {
          prepared = await this.#transport.prepare(snapshot);
          // Persist the exact signed transaction before any network submission.
          this.#db.prepare(`UPDATE observer_root_publications SET wire=?, last_valid_height=?, status='submitted',
            signature=NULL WHERE revision=?`).run(prepared.wire, prepared.lastValidBlockHeight, row.revision);
        }
        const signature = await this.#transport.send(prepared);
        this.#db.prepare("UPDATE observer_root_publications SET signature=? WHERE revision=?").run(signature, row.revision);
        inspected = await this.#transport.inspect(snapshot);
      }
      if (inspected) {
        this.#db.prepare(`UPDATE observer_root_publications SET status='confirmed',checked_slot=?,
          wire=NULL,last_valid_height=NULL,last_error=NULL,retry_at=0 WHERE revision=?`).run(inspected.slot, row.revision);
        this.#checked = { revision: row.revision, active: inspected.active, at: this.#now(), slot: inspected.slot, error: null };
      } else {
        this.#db.prepare("UPDATE observer_root_publications SET retry_at=? WHERE revision=?")
          .run(this.#now() + 2_000, row.revision);
      }
    } catch (error) {
      const code = error instanceof RootPublicationError ? error.code : "rpc_error";
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(row.attempts, 5));
      this.#db.prepare("UPDATE observer_root_publications SET attempts=attempts+1,retry_at=?,last_error=? WHERE revision=?")
        .run(this.#now() + delay, code, row.revision);
    }
  }
}
