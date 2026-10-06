// Public synthetic fixtures only. The Borsh reference below deliberately does
// not import either production codec, so both implementations share an oracle.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const constants = JSON.parse(await readFile(path.resolve(path.dirname(require.resolve("circomlibjs")), "../src/poseidon_constants.json"), "utf8"));
const hex = bytes => "0x" + Buffer.from(bytes).toString("hex");
const field = value => "0x" + BigInt(value).toString(16).padStart(64, "0");
const sha = bytes => createHash("sha256").update(bytes).digest();
const poseidon = await buildPoseidon();
const hash = values => poseidon.F.toObject(poseidon(values));
const idField = (bytes, domain) => hash([domain, BigInt(hex(bytes.subarray(0, 16))), BigInt(hex(bytes.subarray(16)))]);
const little = (value, size) => {
  const result = Buffer.alloc(size); let remaining = BigInt.asUintN(size * 8, BigInt(value));
  for (let index = 0; index < size; index++) { result[index] = Number(remaining & 255n); remaining >>= 8n; }
  return result;
};
const raw = value => Buffer.from(value.slice(2), "hex");
function referenceBytes(t) {
  const l = t.local;
  return Buffer.concat([
    little(t.version, 1), raw(t.protocolID), raw(t.deviceID), raw(t.publicKey), little(t.curve, 1), little(t.epoch, 4),
    little(t.observationTimeMilliseconds, 8), little(t.challenges.length, 4),
    ...t.challenges.flatMap(c => [raw(c.nonce), raw(c.signature), little(c.deviceTimestamp, 8), little(c.deviceCounter, 4), little(c.roundTripMilliseconds, 2), little(c.rssiDBM, 1)]),
    raw(l.geohash6), little(l.gpsAccuracyMeters, 2), little(l.barometerHPATimes10, 2), little(l.motionClass, 1),
    raw(l.wifiBSSIDHash), little(l.rssiSamples.length, 4), ...l.rssiSamples.map(r => little(r, 1)),
    raw(t.evidenceHash), raw(t.pseudonym), raw(t.nullifier), little(t.observerClass, 1),
  ]);
}
const vectors = [];
for (const [index, name] of ["absent-signals", "optional-signals", "integer-boundaries", "present-empty-evidence", "present-evidence"].entries()) {
  const boundary = index === 2;
  const secret = Buffer.alloc(31, index + 1);
  const protocolID = index === 1 ? Buffer.alloc(32, 255) : sha(`Pathnod/DEV31/public-protocol/${index}`);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), sha(`Pathnod/DEV31/public-device-seed/${index}`)]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  const deviceID = sha(Buffer.concat([Buffer.from("Pathnod/device/v0"), publicKey]));
  const epoch = boundary ? 0xffff_ffff : 42, epochSeconds = 60;
  const time = boundary ? 0xffff_ffff_ffff_ffffn : BigInt(epoch * epochSeconds * 1000 + 1234);
  const protocolField = idField(protocolID, 3n), deviceField = idField(deviceID, 4n);
  const pseudo = hash([2n, BigInt(hex(secret)), protocolField]);
  const nullifier = hash([1n, BigInt(hex(secret)), protocolField, deviceField, BigInt(epoch)]);
  const observerClass = boundary ? 3 : 1;
  const evidence = index === 3 ? Buffer.alloc(0) : index === 4 ? Buffer.from("public synthetic service evidence") : undefined;
  const evidenceHash = evidence === undefined ? Buffer.alloc(32) : sha(evidence);
  const challenges = [0, 1, 2].map(attempt => {
    const nonce = sha(`Pathnod/DEV31/public-nonce/${index}/${attempt}`);
    const deviceTimestamp = boundary ? 0xffff_ffff_ffff_ffffn - BigInt(2 - attempt) : BigInt(1000 + attempt);
    const deviceCounter = boundary ? 0xffff_ffff - 2 + attempt : attempt + 1;
    const wireEpoch = Buffer.alloc(4); wireEpoch.writeUInt32BE(epoch);
    const wireTimestamp = Buffer.alloc(8); wireTimestamp.writeBigUInt64BE(deviceTimestamp);
    const wireCounter = Buffer.alloc(4); wireCounter.writeUInt32BE(deviceCounter);
    const message = Buffer.concat([Buffer.from("Pathnod/challenge/v0"), nonce, wireEpoch, raw(field(pseudo)).subarray(0, 8), wireTimestamp, wireCounter, evidenceHash]);
    const signature = sign(null, sha(message), key);
    return { nonce: hex(nonce), signature: hex(signature), deviceTimestamp: String(deviceTimestamp), deviceCounter,
      roundTripMilliseconds: boundary && attempt === 0 ? 65535 : 40 + attempt, rssiDBM: boundary ? [-127, 0, -1][attempt] : -60 - attempt };
  });
  const local = { geohash6: hex(index === 1 ? Buffer.from("ezs42e") : Buffer.alloc(6)),
    gpsAccuracyMeters: boundary ? 65535 : index === 1 ? 16 : 0, barometerHPATimes10: boundary ? 65535 : index === 1 ? 10133 : 0,
    motionClass: boundary ? 3 : index === 1 ? 2 : 0, wifiBSSIDHash: hex(index === 1 ? sha("public synthetic BSSID") : Buffer.alloc(32)),
    rssiSamples: boundary ? Array.from({ length: 20 }, (_, i) => [-127, 0, -1][i % 3]) : [-60, -61, -62, -63, -64] };
  const transcript = { version: 0, protocolID: hex(protocolID), deviceID: hex(deviceID), publicKey: hex(publicKey), curve: 1,
    epoch, observationTimeMilliseconds: String(time), challenges, local, evidenceHash: hex(evidenceHash),
    pseudonym: field(pseudo), nullifier: field(nullifier), observerClass };
  const serialized = referenceBytes(transcript);
  const vector = { name, transcript, evidence: evidence === undefined ? null : hex(evidence),
    bytes: hex(serialized), hash: hex(sha(Buffer.concat([Buffer.from("Pathnod/transcript/v0"), serialized]))),
    secret: hex(secret), protocolField: field(protocolField), deviceField: field(deviceField) };
  if (index < 2) {
    const commitment = hash([BigInt(hex(secret))]);
    let zero = 0n, current = hash([commitment, 1n]); const siblings = [];
    for (let depth = 0; depth < 20; depth++) { siblings.push(field(zero)); current = hash([current, zero]); zero = hash([zero, zero]); }
    vector.enrollment = { commitment: field(commitment), observerClass: 1, leaf: field(hash([commitment, 1n])), leafIndex: 0,
      siblings, directions: Array(20).fill(0), root: field(current), rootRevision: 1 };
    vector.capture = { protocolID: protocolID.toString("base64"), deviceID: deviceID.toString("base64"),
      infoWireData: Buffer.concat([Buffer.from([0, 1, ...publicKey, 0, 0, 0, 2]), Buffer.alloc(32)]).toString("base64"),
      epoch, epochSeconds, observationTimeMilliseconds: Number(time), pseudonym: raw(field(pseudo)).toString("base64"),
      challenges: challenges.map(c => {
        const timestamp = Buffer.alloc(8); timestamp.writeBigUInt64BE(BigInt(c.deviceTimestamp));
        const counter = Buffer.alloc(4); counter.writeUInt32BE(c.deviceCounter);
        return { nonce: raw(c.nonce).toString("base64"), response: Buffer.concat([raw(c.signature), timestamp, counter, Buffer.alloc(2)]).toString("base64"),
          roundTripMilliseconds: c.roundTripMilliseconds, rssiDBM: c.rssiDBM };
      }),
      local: { ...local, geohash6: raw(local.geohash6).toString("base64"), wifiBSSIDHash: raw(local.wifiBSSIDHash).toString("base64") },
      durationMilliseconds: 6522 };
  }
  vectors.push(vector);
}
const parameters = { parameterSet: "circom-bn254-x5", arity: 5,
  roundConstants: constants.C[4].map(field), mds: constants.M[4].map(row => row.map(field)) };
await writeFile(path.join(repo, "apps/ios/Sources/PathnodObserverEnrollment/Resources/poseidon-t6.json"), JSON.stringify(parameters, null, 2) + "\n");
await mkdir(path.join(repo, "fixtures/observations"), { recursive: true });
await writeFile(path.join(repo, "fixtures/observations/transcript-v0.json"), JSON.stringify({ publicTestVectors: true,
  source: "Independent Borsh reference + circomlibjs 0.1.7; synthetic Ed25519 keys only", vectors }, null, 2) + "\n");
console.log("Generated five canonical transcripts, two verified synthetic captures and Poseidon t6 parameters.");
