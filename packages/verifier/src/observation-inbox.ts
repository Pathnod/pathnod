import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildPoseidon } from "circomlibjs";
import { decodeObservationTranscript, observationEvidenceHash, observationTranscriptHash } from "./observation-transcript.ts";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined;
export class ObservationInboxError extends Error {
  readonly code: "invalid_observation" | "receipt_conflict" | "inbox_full";
  constructor(code: ObservationInboxError["code"]) { super(code); this.code = code; }
}
export interface ObservationReceipt { status: "received"; transcript_hash: string; policy_validated: false }
export interface ObservationEnvelope {
  transcript: string; assertion: string; key_id: string;
  zk: { proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: "groth16"; curve: "bn128" }; public: string[] };
  evidence?: string;
}

function record(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ObservationInboxError("invalid_observation");
  const obj = value as Record<string, unknown>;
  if (fields.some(k => !(k in obj)) || Object.keys(obj).some(k => !fields.includes(k) && !optional.includes(k))) {
    throw new ObservationInboxError("invalid_observation");
  }
  return obj;
}
function bytes(value: unknown, limit: number, empty = false): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 ||
      (!empty && value.length === 0) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ObservationInboxError("invalid_observation");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > limit || decoded.toString("base64") !== value) throw new ObservationInboxError("invalid_observation");
  return decoded;
}
function decimal(value: unknown, limit: bigint): string {
  if (typeof value !== "string" || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= limit) {
    throw new ObservationInboxError("invalid_observation");
  }
  return value;
}
const integer = (value: Uint8Array): string => BigInt("0x" + Buffer.from(value).toString("hex")).toString();

/** Framing and public-input consistency only; this is NOT the DEV-33 policy. */
export async function parseObservationEnvelope(value: unknown): Promise<{ envelope: ObservationEnvelope; hash: string }> {
  const obj = record(value, ["transcript", "assertion", "key_id", "zk"], ["evidence"]);
  const transcriptBytes = bytes(obj.transcript, 611);
  let t: ReturnType<typeof decodeObservationTranscript>;
  try { t = decodeObservationTranscript(transcriptBytes); } catch { throw new ObservationInboxError("invalid_observation"); }
  bytes(obj.assertion, 16_384);
  if (typeof obj.key_id !== "string" || obj.key_id.length === 0 || Buffer.byteLength(obj.key_id) > 1024) {
    throw new ObservationInboxError("invalid_observation");
  }
  const evidence = obj.evidence === undefined ? undefined : bytes(obj.evidence, 16_384, true);
  if (!Buffer.from(t.evidenceHash).equals(observationEvidenceHash(evidence))) throw new ObservationInboxError("invalid_observation");
  const zk = record(obj.zk, ["proof", "public"]);
  if (!Array.isArray(zk.public) || zk.public.length !== 7) throw new ObservationInboxError("invalid_observation");
  const inputs = zk.public.map(v => decimal(v, FIELD));
  const poseidon = await (poseidonPromise ??= buildPoseidon());
  const idField = (id: Uint8Array, domain: number): string => poseidon.F.toObject(poseidon([
    BigInt(domain), BigInt("0x" + Buffer.from(id.slice(0, 16)).toString("hex")),
    BigInt("0x" + Buffer.from(id.slice(16)).toString("hex")),
  ])).toString();
  const expected = [idField(t.protocolID, 3), idField(t.deviceID, 4), String(t.epoch),
    integer(t.nullifier), integer(t.pseudonym), String(t.observerClass)];
  if (inputs.slice(1).some((v, i) => v !== expected[i])) throw new ObservationInboxError("invalid_observation");
  const proof = record(zk.proof, ["pi_a", "pi_b", "pi_c", "protocol", "curve"]);
  const point = (value: unknown, length: number): string[] => {
    if (!Array.isArray(value) || value.length !== length) throw new ObservationInboxError("invalid_observation");
    return value.map(v => decimal(v, BASE));
  };
  const a = point(proof.pi_a, 3), c = point(proof.pi_c, 3);
  if (!Array.isArray(proof.pi_b) || proof.pi_b.length !== 3) throw new ObservationInboxError("invalid_observation");
  const b = proof.pi_b.map(v => point(v, 2));
  if (proof.protocol !== "groth16" || proof.curve !== "bn128" || a[2] !== "1" || c[2] !== "1" ||
      b[2]![0] !== "1" || b[2]![1] !== "0") throw new ObservationInboxError("invalid_observation");
  const envelope: ObservationEnvelope = {
    transcript: obj.transcript as string, assertion: obj.assertion as string, key_id: obj.key_id,
    zk: { proof: { pi_a: a, pi_b: b, pi_c: c, protocol: "groth16", curve: "bn128" }, public: inputs },
    ...(evidence === undefined ? {} : { evidence: evidence.toString("base64") }),
  };
  return { envelope, hash: observationTranscriptHash(t).toString("hex") };
}

/** Explicit loopback-only development receipt sink. Never verifies or signs an observation. */
export class DevelopmentObservationInbox {
  readonly #db: DatabaseSync;
  readonly #limit: number;
  constructor(path: string, limit = 4096) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw Error("Invalid inbox limit");
    this.#limit = limit; this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS observation_receipts_v0 (
      transcript_hash TEXT PRIMARY KEY, envelope_hash TEXT NOT NULL, received_at INTEGER NOT NULL)`);
  }
  async receive(input: unknown): Promise<ObservationReceipt> {
    const { envelope, hash } = await parseObservationEnvelope(input);
    const digest = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT envelope_hash FROM observation_receipts_v0 WHERE transcript_hash = ?").get(hash);
      if (row && row.envelope_hash !== digest) throw new ObservationInboxError("receipt_conflict");
      if (!row) {
        const count = this.#db.prepare("SELECT COUNT(*) AS n FROM observation_receipts_v0").get()!;
        if (Number(count.n) >= this.#limit) throw new ObservationInboxError("inbox_full");
        this.#db.prepare("INSERT INTO observation_receipts_v0 VALUES (?, ?, ?)").run(hash, digest, Date.now());
      }
      this.#db.exec("COMMIT");
    } catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw error; }
    return { status: "received", transcript_hash: hash, policy_validated: false };
  }
  close(): void { this.#db.close(); }
}
