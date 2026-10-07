import { createHash } from "node:crypto";

export interface TranscriptChallenge {
  nonce: Uint8Array;
  signature: Uint8Array;
  deviceTimestamp: bigint;
  deviceCounter: number;
  roundTripMilliseconds: number;
  rssiDBM: number;
}

export interface TranscriptLocalSignals {
  geohash6: Uint8Array;
  gpsAccuracyMeters: number;
  barometerHPATimes10: number;
  motionClass: number;
  wifiBSSIDHash: Uint8Array;
  rssiSamples: number[];
}

export interface ObservationTranscript {
  version: 0;
  protocolID: Uint8Array;
  deviceID: Uint8Array;
  publicKey: Uint8Array;
  curve: number;
  epoch: number;
  observationTimeMilliseconds: bigint;
  challenges: TranscriptChallenge[];
  local: TranscriptLocalSignals;
  evidenceHash: Uint8Array;
  pseudonym: Uint8Array;
  nullifier: Uint8Array;
  observerClass: number;
}

export class TranscriptEncodingError extends Error {
  constructor() { super("Invalid OBS_TRANSCRIPT_V0 encoding"); }
}

const modulus = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = (): never => { throw new TranscriptEncodingError(); };
function bytes(value: Uint8Array, size: number): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== size) fail();
  return Buffer.from(value);
}
function integer(value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) fail();
}
function field(value: Uint8Array): void {
  if (BigInt(`0x${bytes(value, 32).toString("hex")}`) >= modulus) fail();
}

/** Structural validation only. Signature, freshness and root policy remain DEV-33. */
export function validateObservationTranscript(value: ObservationTranscript): void {
  if (value.version !== 0) fail();
  for (const part of [value.protocolID, value.deviceID, value.publicKey, value.evidenceHash]) bytes(part, 32);
  if (value.protocolID.every(byte => byte === 0)) fail();
  field(value.pseudonym); field(value.nullifier);
  integer(value.curve, 1, 2); integer(value.observerClass, 1, 3); integer(value.epoch, 0, 0xffff_ffff);
  const u64 = (input: bigint) => { if (typeof input !== "bigint" || input < 0n || input > 0xffff_ffff_ffff_ffffn) fail(); };
  u64(value.observationTimeMilliseconds);
  if (value.challenges.length !== 3) fail();
  const nonces = new Set<string>();
  for (const challenge of value.challenges) {
    nonces.add(bytes(challenge.nonce, 32).toString("hex")); bytes(challenge.signature, 64);
    u64(challenge.deviceTimestamp); integer(challenge.deviceCounter, 0, 0xffff_ffff);
    integer(challenge.roundTripMilliseconds, 0, 0xffff); integer(challenge.rssiDBM, -127, 0);
  }
  if (nonces.size !== 3) fail();
  const local = value.local;
  const geo = bytes(local.geohash6, 6);
  if (!geo.every(byte => byte === 0) && !geo.every(byte => Buffer.from("0123456789bcdefghjkmnpqrstuvwxyz").includes(byte))) fail();
  bytes(local.wifiBSSIDHash, 32); integer(local.gpsAccuracyMeters, 0, 0xffff);
  integer(local.barometerHPATimes10, 0, 0xffff); integer(local.motionClass, 0, 3);
  if (local.rssiSamples.length < 5 || local.rssiSamples.length > 20) fail();
  for (const rssi of local.rssiSamples) integer(rssi, -127, 0);
}

export function encodeObservationTranscript(value: ObservationTranscript): Buffer {
  validateObservationTranscript(value);
  const parts: Buffer[] = [];
  const raw = (input: Uint8Array) => { parts.push(Buffer.from(input)); };
  const num = (input: number | bigint, size: number) => {
    const buffer = Buffer.alloc(size); let remaining = BigInt(input);
    for (let index = 0; index < size; index++) { buffer[index] = Number(remaining & 255n); remaining >>= 8n; }
    parts.push(buffer);
  };
  num(0, 1); raw(value.protocolID); raw(value.deviceID); raw(value.publicKey); num(value.curve, 1);
  num(value.epoch, 4); num(value.observationTimeMilliseconds, 8); num(value.challenges.length, 4);
  for (const challenge of value.challenges) {
    raw(challenge.nonce); raw(challenge.signature); num(challenge.deviceTimestamp, 8); num(challenge.deviceCounter, 4);
    num(challenge.roundTripMilliseconds, 2); num(challenge.rssiDBM, 1);
  }
  const local = value.local;
  raw(local.geohash6); num(local.gpsAccuracyMeters, 2); num(local.barometerHPATimes10, 2);
  num(local.motionClass, 1); raw(local.wifiBSSIDHash); num(local.rssiSamples.length, 4);
  for (const rssi of local.rssiSamples) num(rssi, 1);
  raw(value.evidenceHash); raw(value.pseudonym); raw(value.nullifier); num(value.observerClass, 1);
  return Buffer.concat(parts);
}

export function decodeObservationTranscript(input: Uint8Array): ObservationTranscript {
  if (!(input instanceof Uint8Array) || input.length < 596 || input.length > 611) fail();
  const data = Buffer.from(input); let offset = 0;
  const raw = (size: number): Buffer => {
    if (size > data.length - offset) fail();
    const value = Buffer.from(data.subarray(offset, offset + size)); offset += size; return value;
  };
  const big = (size: number): bigint => {
    const value = raw(size); let result = 0n;
    for (let index = size - 1; index >= 0; index--) result = (result << 8n) | BigInt(value[index]!);
    return result;
  };
  const num = (size: number) => Number(big(size));
  const rssi = () => { const value = num(1); return value >= 128 ? value - 256 : value; };
  if (num(1) !== 0) fail();
  const protocolID = raw(32), deviceID = raw(32), publicKey = raw(32), curve = num(1), epoch = num(4);
  const observationTimeMilliseconds = big(8);
  if (num(4) !== 3) fail();
  const challenges: TranscriptChallenge[] = [];
  for (let index = 0; index < 3; index++) challenges.push({ nonce: raw(32), signature: raw(64), deviceTimestamp: big(8),
    deviceCounter: num(4), roundTripMilliseconds: num(2), rssiDBM: rssi() });
  const local: TranscriptLocalSignals = { geohash6: raw(6), gpsAccuracyMeters: num(2), barometerHPATimes10: num(2),
    motionClass: num(1), wifiBSSIDHash: raw(32), rssiSamples: [] };
  const count = num(4);
  if (count < 5 || count > 20) fail();
  for (let index = 0; index < count; index++) local.rssiSamples.push(rssi());
  const value: ObservationTranscript = { version: 0, protocolID, deviceID, publicKey, curve, epoch,
    observationTimeMilliseconds, challenges, local, evidenceHash: raw(32), pseudonym: raw(32), nullifier: raw(32), observerClass: num(1) };
  if (offset !== data.length) fail();
  validateObservationTranscript(value); return value;
}

export function observationTranscriptHash(value: ObservationTranscript): Buffer {
  return createHash("sha256").update("Pathnod/transcript/v0", "ascii").update(encodeObservationTranscript(value)).digest();
}

/** Absent evidence is zero; explicitly present empty evidence is SHA-256(empty). */
export function observationEvidenceHash(evidence?: Uint8Array): Buffer {
  return evidence === undefined ? Buffer.alloc(32) : createHash("sha256").update(evidence).digest();
}
