import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { appendObservationTree } from "@pathnod/solana";
import {
  decodeObservationTranscript,
  observationTranscriptHash,
  observationEvidenceHash,
  type ObservationTranscript,
} from "./observation-transcript.ts";

const BPS = 10_000;
const WINDOW_MS = 30 * 86400 * 1000;
export const CONFIDENCE_POLICY_V0 = Object.freeze({
  version: 1,
  scale: BPS,
  historyWindowMilliseconds: WINDOW_MS,
  witnessTarget: 3,
  unknownDeployerWeightBps: 2000,
  cooccurrenceThresholdBps: 8000,
  spatialMinimumWitnesses: 3,
  spatialCapBps: 5000,
  gpsAccuracyLimitMeters: 1000,
  entropyTargetCategories: 4,
  evidencePresenceBps: 2500,
  maximumHistoryRecords: 10000,
  maximumHistoryPseudonyms: 512,
  hardwareClassBps: Object.freeze([0, 10_000, 10_000, 8000]),
  weights: Object.freeze([2500, 1000, 3000, 1500, 1500, 500]),
});

export interface ConfidenceInput {
  transcript: string;
  evidence?: string;
  /** Authenticated enrollment risk metadata; null means the metric is unavailable. */
  reenrollmentCount: number | null;
}
export interface ConfidenceScope {
  program: string;
  protocolID: string;
  deviceID: string;
  epoch: number;
  policyVersion: number;
  epochSeconds: number;
  evaluatedAtMilliseconds: number;
  observationRoot: string;
  /** Native epoch tree insertion order, verified against the on-chain root. */
  transcriptOrder: string[];
  claimedGeohash6: string | null;
}

export function canonicalConfidenceBytes(value: unknown): Buffer {
  const canonical = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return v;
    if (Array.isArray(v)) return v.map(canonical);
    if (
      v &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, canonical(x)]),
      );
    }
    throw Error("Noncanonical confidence value");
  };
  return Buffer.from(JSON.stringify(canonical(value)), "utf8");
}
function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update(canonicalConfidenceBytes(value))
    .digest("hex");
}
export function confidenceCommitment(report: unknown): string {
  return digest("Pathnod/confidence/v0", report);
}
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
function geohash(value: string): boolean {
  return /^[0123456789bcdefghjkmnpqrstuvwxyz]{6}$/.test(value);
}
function strictBase64(value: string): Buffer {
  if (
    value.length > 131072 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw Error("Invalid confidence input encoding");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value)
    throw Error("Noncanonical confidence input encoding");
  return data;
}
const clamp = (n: number) => Math.max(0, Math.min(BPS, n));
const average = (values: number[]) =>
  values.length
    ? Math.floor(values.reduce((a, b) => a + b, 0) / values.length)
    : 0;
/** Q24 log2 using integer squaring, identical across JS runtimes. */
function log2(value: bigint): bigint {
  if (value < 1n) throw Error("Invalid entropy argument");
  const bits = value.toString(2).length - 1,
    precision = 48n;
  let x = (value << precision) >> BigInt(bits),
    result = BigInt(bits) << 24n;
  for (let bit = 23; bit >= 0; bit--) {
    x = (x * x) >> precision;
    if (x >= 2n << precision) {
      x >>= 1n;
      result |= 1n << BigInt(bit);
    }
  }
  return result;
}
function entropy(values: string[]): number {
  if (values.length < 2) return 0;
  const counts = new Map<string, bigint>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0n) + 1n);
  const n = BigInt(values.length);
  let terms = 0n;
  for (const count of counts.values()) terms += count * log2(count);
  const h = log2(n) - terms / n;
  return clamp(
    Number(
      (h * BigInt(BPS)) /
        log2(BigInt(CONFIDENCE_POLICY_V0.entropyTargetCategories)),
    ),
  );
}
type RecordValue = {
  hash: string;
  transcript: ObservationTranscript;
  input: ConfidenceInput;
  pseudonym: string;
  slot: string;
};

export function computeConfidence(
  scope: ConfidenceScope,
  inputs: ConfidenceInput[],
) {
  new PublicKey(scope.program);
  if (
    ![scope.protocolID, scope.deviceID, scope.observationRoot].every((v) =>
      /^[a-f0-9]{64}$/.test(v),
    ) ||
    !Number.isSafeInteger(scope.evaluatedAtMilliseconds) ||
    scope.evaluatedAtMilliseconds < 0 ||
    !Number.isInteger(scope.epoch) ||
    scope.epoch < 0 ||
    scope.epoch > 0xffff_ffff ||
    !Number.isInteger(scope.policyVersion) ||
    scope.policyVersion < 1 ||
    scope.policyVersion > 0xffff_ffff ||
    !Number.isInteger(scope.epochSeconds) ||
    scope.epochSeconds < 1 ||
    scope.epochSeconds > 0xffff_ffff ||
    scope.evaluatedAtMilliseconds < scope.epoch * scope.epochSeconds * 1000 ||
    (scope.claimedGeohash6 !== null && !geohash(scope.claimedGeohash6)) ||
    !inputs.length ||
    inputs.length > CONFIDENCE_POLICY_V0.maximumHistoryRecords
  )
    throw Error("Invalid confidence scope");
  const records: RecordValue[] = [];
  const nullifiers = new Set<string>();
  for (const input of inputs) {
    if (
      input.reenrollmentCount !== null &&
      (!Number.isInteger(input.reenrollmentCount) ||
        input.reenrollmentCount < 0 ||
        input.reenrollmentCount > 1_000_000)
    )
      throw Error("Invalid enrollment risk metric");
    const transcript = decodeObservationTranscript(
        strictBase64(input.transcript),
      ),
      hash = hex(observationTranscriptHash(transcript));
    if (
      hex(transcript.protocolID) !== scope.protocolID ||
      transcript.observationTimeMilliseconds >
        BigInt(scope.evaluatedAtMilliseconds) ||
      Number(
        transcript.observationTimeMilliseconds /
          BigInt(scope.epochSeconds * 1000),
      ) !== transcript.epoch
    )
      throw Error("Confidence history scope/time mismatch");
    if (
      hex(
        observationEvidenceHash(
          input.evidence === undefined
            ? undefined
            : strictBase64(input.evidence),
        ),
      ) !== hex(transcript.evidenceHash)
    )
      throw Error("Confidence evidence binding mismatch");
    const nullifier = hex(transcript.nullifier);
    if (nullifiers.has(nullifier))
      throw Error("Duplicate confidence nullifier");
    nullifiers.add(nullifier);
    records.push({
      hash,
      transcript,
      input,
      pseudonym: hex(transcript.pseudonym),
      slot: `${hex(transcript.deviceID)}/${transcript.epoch}`,
    });
  }
  records.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const target = records.filter(
    (r) =>
      hex(r.transcript.deviceID) === scope.deviceID &&
      r.transcript.epoch === scope.epoch,
  );
  if (
    !target.length ||
    target.length !== scope.transcriptOrder.length ||
    new Set(scope.transcriptOrder).size !== target.length ||
    target.some((r) => !scope.transcriptOrder.includes(r.hash))
  )
    throw Error("Incomplete target epoch history");
  let frontier: Uint8Array[] = Array.from({ length: 16 }, () =>
    Buffer.alloc(32),
  );
  let root: Uint8Array = Buffer.alloc(32),
    count = 0;
  for (const hash of scope.transcriptOrder) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid transcript order");
    const next = appendObservationTree(
      frontier,
      count++,
      Buffer.from(hash, "hex"),
    );
    frontier = next.frontier;
    root = next.root;
  }
  if (hex(root) !== scope.observationRoot)
    throw Error("Confidence observation tree mismatch");
  const window = records.filter(
    (r) =>
      Number(r.transcript.observationTimeMilliseconds) >=
      scope.evaluatedAtMilliseconds - WINDOW_MS,
  );
  const pseudos = [
    ...new Set([...window, ...target].map((r) => r.pseudonym)),
  ].sort();
  if (pseudos.length > CONFIDENCE_POLICY_V0.maximumHistoryPseudonyms)
    throw Error("Confidence history exceeds the v0 computation limit");
  const parent = new Map(pseudos.map((p) => [p, p]));
  const find = (p: string): string => {
    const root = parent.get(p)!;
    if (root === p) return p;
    const result = find(root);
    parent.set(p, result);
    return result;
  };
  const slots = new Map(
    pseudos.map((p) => [
      p,
      new Set(window.filter((r) => r.pseudonym === p).map((r) => r.slot)),
    ]),
  );
  for (let i = 0; i < pseudos.length; i++)
    for (let j = i + 1; j < pseudos.length; j++) {
      const a = pseudos[i]!,
        b = pseudos[j]!,
        sa = slots.get(a)!,
        sb = slots.get(b)!;
      const intersection = [...sa].filter((s) => sb.has(s)).length,
        denominator = Math.max(sa.size, sb.size);
      if (
        denominator &&
        intersection * BPS >
          denominator * CONFIDENCE_POLICY_V0.cooccurrenceThresholdBps
      )
        parent.set(find(b), find(a));
    }
  const groupMap = new Map<string, RecordValue[]>();
  for (const record of target) {
    const group = find(record.pseudonym);
    groupMap.set(group, [...(groupMap.get(group) ?? []), record]);
  }
  const groups = [...groupMap.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const hardware = average(
    groups.map(([, rs]) =>
      Math.min(
        ...rs.map((r) => {
          const base =
            CONFIDENCE_POLICY_V0.hardwareClassBps[r.transcript.observerClass]!;
          return Math.floor(
            base /
              (1 +
                (r.input.reenrollmentCount === null
                  ? 0
                  : Math.floor(r.input.reenrollmentCount / 3))),
          );
        }),
      ),
    ),
  );
  const freshness = average(
    groups.map(([, rs]) =>
      Math.min(
        ...rs.map((r) =>
          clamp(
            BPS -
              Math.floor(
                ((scope.evaluatedAtMilliseconds -
                  Number(r.transcript.observationTimeMilliseconds)) *
                  BPS) /
                  (scope.epochSeconds * 1000),
              ),
          ),
        ),
      ),
    ),
  );
  const witness = clamp(
    Math.floor(
      (groups.length * CONFIDENCE_POLICY_V0.unknownDeployerWeightBps) /
        CONFIDENCE_POLICY_V0.witnessTarget,
    ),
  );
  const geographic = groups.map(([, rs]) => {
    const usable = rs.filter(
      (r) =>
        r.transcript.local.gpsAccuracyMeters > 0 &&
        geohash(Buffer.from(r.transcript.local.geohash6).toString("ascii")),
    );
    const locations = new Set(
      usable.map((r) =>
        Buffer.from(r.transcript.local.geohash6).toString("ascii"),
      ),
    );
    if (locations.size !== 1 || usable.length !== rs.length)
      return { geo: null, quality: 0 };
    return {
      geo: [...locations][0]!,
      quality: Math.min(
        ...usable.map((r) =>
          clamp(
            BPS -
              Math.floor(
                (r.transcript.local.gpsAccuracyMeters * BPS) /
                  CONFIDENCE_POLICY_V0.gpsAccuracyLimitMeters,
              ),
          ),
        ),
      ),
    };
  });
  const votes = new Map<string, number>();
  for (const g of geographic)
    if (g.geo) votes.set(g.geo, (votes.get(g.geo) ?? 0) + g.quality);
  let spatial = Math.floor(Math.max(0, ...votes.values()) / groups.length);
  if (scope.claimedGeohash6 !== null)
    spatial = Math.floor(
      (spatial + (votes.get(scope.claimedGeohash6) ?? 0) / groups.length) / 2,
    );
  if (groups.length < CONFIDENCE_POLICY_V0.spatialMinimumWitnesses)
    spatial = Math.min(spatial, CONFIDENCE_POLICY_V0.spatialCapBps);
  const behavior = average(
    groups.map(([group]) => {
      const history = window.filter((r) => find(r.pseudonym) === group);
      return average([
        entropy(history.map((r) => hex(r.transcript.deviceID))),
        entropy(
          history.map((r) =>
            String(
              Math.floor(
                Number(r.transcript.observationTimeMilliseconds) / 3600000,
              ) % 24,
            ),
          ),
        ),
        entropy(
          history
            .map((r) =>
              Buffer.from(r.transcript.local.geohash6).toString("ascii"),
            )
            .filter(geohash),
        ),
      ]);
    }),
  );
  const service = average(
    groups.map(([, rs]) =>
      Math.min(
        ...rs.map((r) => {
          if (!r.input.evidence) return 0;
          try {
            const e = JSON.parse(
              strictBase64(r.input.evidence).toString("utf8"),
            ) as Record<string, unknown>;
            if (
              e.version === 0 &&
              e.type === "wifi" &&
              typeof e.bssid_hash === "string" &&
              /^[a-f0-9]{64}$/.test(e.bssid_hash) &&
              e.bssid_hash !== "0".repeat(64) &&
              e.bssid_hash === hex(r.transcript.local.wifiBSSIDHash)
            )
              return BPS;
          } catch {
            /* Unknown evidence schemas only receive the documented presence score. */
          }
          return CONFIDENCE_POLICY_V0.evidencePresenceBps;
        }),
      ),
    ),
  );
  const facets = {
    hardware_confidence: hardware,
    temporal_freshness: freshness,
    witness_diversity: witness,
    spatial_consistency: spatial,
    behavior_diversity: behavior,
    service_evidence: service,
  };
  const score = Math.floor(
    [hardware, freshness, witness, spatial, behavior, service].reduce(
      (n, v, i) => n + v * CONFIDENCE_POLICY_V0.weights[i]!,
      0,
    ) / BPS,
  );
  return {
    version: 1,
    policy: CONFIDENCE_POLICY_V0,
    scope: { ...scope },
    inputsHash: digest(
      "Pathnod/confidence-inputs/v0",
      records.map((r) => r.input),
    ),
    facets,
    score,
    observers: {
      raw: target.length,
      groups: groups.length,
      weightedBps:
        groups.length * CONFIDENCE_POLICY_V0.unknownDeployerWeightBps,
    },
    coverage: {
      historyObservations: window.length,
      geographicGroups: geographic.filter((g) => g.geo).length,
      reenrollmentRiskAvailable: target.every(
        (r) => r.input.reenrollmentCount !== null,
      ),
      crossDeployerHistory: "unavailable",
    },
    status:
      groups.length >= 3 && witness >= 5000 && hardware >= 8000
        ? "VERIFIED"
        : "LOW",
  };
}
