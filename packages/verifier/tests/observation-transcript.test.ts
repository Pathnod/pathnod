import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildPoseidon } from "circomlibjs";
import { encodeObservationTranscript, decodeObservationTranscript, observationTranscriptHash, observationEvidenceHash,
  TranscriptEncodingError, type ObservationTranscript } from "../src/observation-transcript.ts";

const fixtures = JSON.parse(readFileSync(new URL("../../../fixtures/observations/transcript-v0.json", import.meta.url), "utf8")) as {
  publicTestVectors: boolean;
  vectors: { name: string; bytes: string; hash: string; evidence: string | null; secret: string; protocolField: string; deviceField: string;
    transcript: Omit<ObservationTranscript, "protocolID" | "deviceID" | "publicKey" | "observationTimeMilliseconds" | "challenges" | "local" | "evidenceHash" | "pseudonym" | "nullifier"> & {
      protocolID: string; deviceID: string; publicKey: string; observationTimeMilliseconds: string; evidenceHash: string; pseudonym: string; nullifier: string;
      challenges: { nonce: string; signature: string; deviceTimestamp: string; deviceCounter: number; roundTripMilliseconds: number; rssiDBM: number }[];
      local: { geohash6: string; wifiBSSIDHash: string; gpsAccuracyMeters: number; barometerHPATimes10: number; motionClass: number; rssiSamples: number[] };
    };
  }[];
};
const raw = (hex: string) => Buffer.from(hex.slice(2), "hex");
function input(vector: (typeof fixtures.vectors)[number]): ObservationTranscript {
  const t = vector.transcript;
  return { ...t, protocolID: raw(t.protocolID), deviceID: raw(t.deviceID), publicKey: raw(t.publicKey),
    observationTimeMilliseconds: BigInt(t.observationTimeMilliseconds), evidenceHash: raw(t.evidenceHash), pseudonym: raw(t.pseudonym), nullifier: raw(t.nullifier),
    challenges: t.challenges.map(c => ({ ...c, nonce: raw(c.nonce), signature: raw(c.signature), deviceTimestamp: BigInt(c.deviceTimestamp) })),
    local: { ...t.local, geohash6: raw(t.local.geohash6), wifiBSSIDHash: raw(t.local.wifiBSSIDHash) } };
}

test("Swift/TS fixtures match the independent canonical Borsh bytes and domain-separated hash", () => {
  assert.equal(fixtures.publicTestVectors, true);
  for (const vector of fixtures.vectors) {
    const t = input(vector), expected = raw(vector.bytes);
    assert.deepEqual(encodeObservationTranscript(t), expected, vector.name);
    assert.deepEqual(decodeObservationTranscript(expected), t);
    assert.deepEqual(observationTranscriptHash(t), raw(vector.hash));
    assert.deepEqual(observationEvidenceHash(vector.evidence === null ? undefined : raw(vector.evidence)), t.evidenceHash);
    assert.notDeepEqual(observationTranscriptHash(t), createHash("sha256").update(expected).digest());
    assert.notDeepEqual(observationTranscriptHash({ ...t, observationTimeMilliseconds: t.observationTimeMilliseconds ^ 1n }), raw(vector.hash));
  }
});

test("IDs, pseudonyms and nullifiers match the circuit's domain-separated Poseidon formulas", async () => {
  const poseidon = await buildPoseidon(), hash = (values: bigint[]) => poseidon.F.toObject(poseidon(values));
  const idField = (id: string, domain: bigint) => hash([domain, BigInt("0x" + id.slice(2, 34)), BigInt("0x" + id.slice(34))]);
  for (const vector of fixtures.vectors) {
    const protocol = idField(vector.transcript.protocolID, 3n), device = idField(vector.transcript.deviceID, 4n), secret = BigInt(vector.secret);
    assert.equal(protocol, BigInt(vector.protocolField)); assert.equal(device, BigInt(vector.deviceField));
    assert.equal(hash([2n, secret, protocol]), BigInt(vector.transcript.pseudonym));
    assert.equal(hash([1n, secret, protocol, device, BigInt(vector.transcript.epoch)]), BigInt(vector.transcript.nullifier));
  }
});

test("malformed framing, unbounded lengths and invalid fields are rejected", () => {
  const data = raw(fixtures.vectors[0]!.bytes);
  for (let length = 0; length < data.length; length++) assert.throws(() => decodeObservationTranscript(data.subarray(0, length)));
  assert.throws(() => decodeObservationTranscript(Buffer.concat([data, Buffer.from([0])])));
  for (const [offset, size, value] of [[0, 1, 1], [110, 4, 0xffff_ffff], [490, 4, 0xffff_ffff]] as const) {
    const corrupted = Buffer.from(data);
    if (size === 1) corrupted.writeUInt8(value, offset); else corrupted.writeUInt32LE(value, offset);
    assert.throws(() => decodeObservationTranscript(corrupted), TranscriptEncodingError);
  }
  const t = input(fixtures.vectors[0]!);
  for (const invalid of [{ ...t, epoch: -1 }, { ...t, epoch: 1.5 }, { ...t, observationTimeMilliseconds: 1n << 64n },
    { ...t, observerClass: 0 }, { ...t, publicKey: Buffer.alloc(31) }, { ...t, pseudonym: Buffer.alloc(32, 255) },
    { ...t, challenges: [t.challenges[0]!, t.challenges[0]!, t.challenges[2]!] },
    { ...t, local: { ...t.local, rssiSamples: [-128, -60, -60, -60, -60] } }]) {
    assert.throws(() => encodeObservationTranscript(invalid), TranscriptEncodingError);
  }
});
