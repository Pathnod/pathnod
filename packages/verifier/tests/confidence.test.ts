import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appendObservationTree } from "@pathnod/solana";
import {
  computeConfidence,
  confidenceCommitment,
  canonicalConfidenceBytes,
  type ConfidenceScope,
  type ConfidenceInput,
} from "../src/confidence.ts";
import {
  ConfidenceRecorder,
  openConfidenceInput,
  sealConfidenceInput,
} from "../src/confidence-store.ts";
import {
  decodeObservationTranscript,
  encodeObservationTranscript,
  observationTranscriptHash,
  observationEvidenceHash,
} from "../src/observation-transcript.ts";

const vector = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/observations/transcript-v0.json",
      import.meta.url,
    ),
    "utf8",
  ),
).vectors[0];
const seed = decodeObservationTranscript(
  Buffer.from(vector.bytes.slice(2), "hex"),
);
const epochSeconds = 604800,
  epoch = 42,
  now = epoch * epochSeconds * 1000 + 3600_000;
function row(
  pseudonym: number,
  device: number = 1,
  time = now,
  geo: string | null = null,
  risk: number | null = null,
  evidence?: string,
): ConfidenceInput {
  const field = (n: number) => {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(n, 28);
    return b;
  };
  const t = {
    ...seed,
    protocolID: Buffer.alloc(32, 1),
    deviceID: field(device),
    epoch: Math.floor(time / (epochSeconds * 1000)),
    observationTimeMilliseconds: BigInt(time),
    pseudonym: field(pseudonym),
    nullifier: field(
      pseudonym * 100000 + device * 100 + (Math.floor(time / 3600000) % 100),
    ),
    evidenceHash: observationEvidenceHash(
      evidence === undefined ? undefined : Buffer.from(evidence),
    ),
    local: {
      ...seed.local,
      geohash6: geo ? Buffer.from(geo) : Buffer.alloc(6),
      gpsAccuracyMeters: geo ? 10 : 0,
      wifiBSSIDHash: Buffer.alloc(32, 9),
    },
  };
  return {
    transcript: encodeObservationTranscript(t).toString("base64"),
    reenrollmentCount: risk,
    ...(evidence === undefined
      ? {}
      : { evidence: Buffer.from(evidence).toString("base64") }),
  };
}
function scope(rows: ConfidenceInput[]): ConfidenceScope {
  const target = rows
    .map((r) =>
      decodeObservationTranscript(Buffer.from(r.transcript, "base64")),
    )
    .filter((t) => t.deviceID[31] === 1 && t.epoch === epoch);
  let frontier: Uint8Array[] = Array.from({ length: 16 }, () =>
      Buffer.alloc(32),
    ),
    root: Uint8Array = Buffer.alloc(32);
  const order: string[] = [];
  for (const t of target) {
    const hash = observationTranscriptHash(t);
    const next = appendObservationTree(frontier, order.length, hash);
    frontier = next.frontier;
    root = next.root;
    order.push(hash.toString("hex"));
  }
  return {
    program: "5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd",
    protocolID: "01".repeat(32),
    deviceID: Buffer.concat([Buffer.alloc(31), Buffer.from([1])]).toString(
      "hex",
    ),
    epoch,
    epochSeconds,
    policyVersion: 1,
    evaluatedAtMilliseconds: now,
    observationRoot: Buffer.from(root).toString("hex"),
    transcriptOrder: order,
    claimedGeohash6: null,
  };
}
test("DEV-39 has six bounded facets, conservative witness weight and no fabricated missing signals", () => {
  const rows = [row(1)],
    result = computeConfidence(scope(rows), rows);
  assert.deepEqual(result.facets, {
    hardware_confidence: 10000,
    temporal_freshness: 10000,
    witness_diversity: 666,
    spatial_consistency: 0,
    behavior_diversity: 0,
    service_evidence: 0,
  });
  assert.equal(result.observers.weightedBps, 2000);
  assert.equal(result.status, "LOW");
  assert.equal(result.coverage.reenrollmentRiskAvailable, false);
  const missing = computeConfidence(
    { ...scope(rows), evaluatedAtMilliseconds: now + epochSeconds * 1000 },
    rows,
  );
  assert.equal(missing.facets.temporal_freshness, 0);
  const risk = [row(1, 1, now, null, 3)];
  assert.equal(
    computeConfidence(scope(risk), risk).facets.hardware_confidence,
    5000,
  );
});
test("DEV-39 merges at strictly greater than 80%, including transitive co-occurrence", () => {
  const rows = [row(1), row(2), row(3)];
  assert.equal(computeConfidence(scope(rows), rows).observers.groups, 1);
  const history = [
    row(1),
    row(2),
    ...Array.from({ length: 3 }, (_, i) => [
      row(1, i + 2),
      row(2, i + 2),
    ]).flat(),
    row(1, 9),
    row(2, 10),
  ];
  assert.equal(computeConfidence(scope(history), history).observers.groups, 2);
  const shared = [...history, row(1, 11), row(2, 11)];
  assert.equal(computeConfidence(scope(shared), shared).observers.groups, 1);
  const chain = [
    row(1),
    row(2),
    row(3),
    ...Array.from({ length: 80 }, (_, i) => row(1, i + 2)),
    ...Array.from({ length: 99 }, (_, i) => row(2, i + 2)),
    ...Array.from({ length: 80 }, (_, i) => row(3, i + 21)),
  ];
  assert.equal(computeConfidence(scope(chain), chain).observers.groups, 1);
});
test("DEV-39 caps spatial confidence below three merged witnesses and applies missing/disagreeing signals", () => {
  const one = [row(1, 1, now, "u09tun")];
  assert.equal(
    computeConfidence(scope(one), one).facets.spatial_consistency,
    5000,
  );
  const three = [
    row(1, 1, now, "u09tun"),
    row(2, 1, now, "u09tun"),
    row(3, 1, now, "u09tun"),
    row(1, 2),
    row(2, 3),
    row(3, 4),
  ];
  const report = computeConfidence(scope(three), three);
  assert.equal(report.observers.groups, 3);
  assert.equal(report.facets.spatial_consistency, 9900);
  const disagree = computeConfidence(
    { ...scope(three), claimedGeohash6: "u09tup" },
    three,
  );
  assert.equal(disagree.facets.spatial_consistency, 4950);
});
test("DEV-39 evidence scores require the signed hash and matching observer measurement", () => {
  const evidence = JSON.stringify({
      version: 0,
      type: "wifi",
      bssid_hash: "09".repeat(32),
    }),
    rows = [row(1, 1, now, null, null, evidence)];
  assert.equal(
    computeConfidence(scope(rows), rows).facets.service_evidence,
    10000,
  );
  const unknown = [row(1, 1, now, null, null, "unrecognized")];
  assert.equal(
    computeConfidence(scope(unknown), unknown).facets.service_evidence,
    2500,
  );
  assert.throws(() =>
    computeConfidence(scope(rows), [
      { ...rows[0]!, evidence: Buffer.from("altered").toString("base64") },
    ]),
  );
});
test("DEV-39 canonical commitment is order independent for history but bound to all policy/scope/measurement fields", () => {
  const rows = [
      row(1),
      row(1, 2, now - 3600000),
      row(1, 3, now - 7200000, "u09tun"),
    ],
    s = scope(rows),
    report = computeConfidence(s, rows);
  assert.ok(report.facets.behavior_diversity > 0);
  assert.equal(
    confidenceCommitment(report),
    confidenceCommitment(computeConfidence(s, [...rows].reverse())),
  );
  assert.notEqual(
    confidenceCommitment(report),
    confidenceCommitment({ ...report, score: report.score + 1 }),
  );
  assert.equal(
    canonicalConfidenceBytes({ b: 1, a: 2 }).toString(),
    '{"a":2,"b":1}',
  );
  assert.throws(() => canonicalConfidenceBytes({ bad: 0.1 }));
  assert.throws(
    () => computeConfidence({ ...s, protocolID: "02".repeat(32) }, rows),
    /scope/,
  );
  assert.throws(
    () => computeConfidence({ ...s, observationRoot: "00".repeat(32) }, rows),
    /tree/,
  );
  assert.throws(() => computeConfidence(s, [...rows, rows[0]!]), /Duplicate/);
});
test("DEV-39 requester encryption authenticates scope and hash and cannot leak plaintext or mix keys", () => {
  const key = generateKeyPairSync("x25519"),
    other = generateKeyPairSync("x25519"),
    input = row(1),
    hash = "11".repeat(32);
  const sealed = sealConfidenceInput(key.publicKey, "target", hash, input);
  assert.ok(!sealed.includes(input.transcript));
  assert.deepEqual(
    openConfidenceInput(key.privateKey, "target", hash, sealed),
    input,
  );
  assert.throws(() =>
    openConfidenceInput(key.privateKey, "other", hash, sealed),
  );
  assert.throws(() =>
    openConfidenceInput(other.privateKey, "target", hash, sealed),
  );
  const db = new DatabaseSync(":memory:");
  try {
    const recorder = new ConfidenceRecorder(key.publicKey);
    recorder.initialize(db);
    recorder.record(db, "target", hash, input);
    assert.throws(
      () => new ConfidenceRecorder(other.publicKey).initialize(db),
      /another requester/,
    );
    db.exec("BEGIN");
    recorder.record(db, "target", "22".repeat(32), input);
    db.exec("ROLLBACK");
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM confidence_inputs_v0").get()?.n,
      1,
    );
  } finally {
    db.close();
  }
});
