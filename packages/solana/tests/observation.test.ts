import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage, VersionedTransaction, AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  appendObservationTree,
  DEFAULT_OBSERVATION_KEY_DIGEST,
  decodeDeviceEpoch,
  decodeObservationCommitment,
  decodeObservationVerifier,
  discriminator,
  observationAddresses,
  submitObservation,
  verificationKeyDigest,
} from "../src/index.ts";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/observations/${name}`, import.meta.url),
      "utf8",
    ),
  );
const fromHex = (value: string) => Buffer.from(value.replace(/^0x/, ""), "hex");

test("DEV-35: compiled verification-key digest and independent full-tree vectors", () => {
  assert.equal(
    verificationKeyDigest(fixture("dev35-verification-key.json")),
    DEFAULT_OBSERVATION_KEY_DIGEST,
  );
  const vectors = fixture("dev35-tree.json");
  let frontier: Buffer[] = Array.from({ length: 16 }, () => Buffer.alloc(32));
  for (let i = 0; i < vectors.transcriptHashes.length; i++) {
    const next = appendObservationTree(
      frontier,
      i,
      fromHex(vectors.transcriptHashes[i]),
    );
    frontier = next.frontier;
    assert.equal(next.root.toString("hex"), vectors.roots[i]);
    assert.equal(next.count, i + 1);
  }
  assert.throws(
    () => appendObservationTree(frontier, 65535, Buffer.alloc(32)),
    /count/,
  );
});
test("DEV-36: payment instruction fits a signed v0 packet using lookup addresses", () => {
  const vector = fixture("dev35-proofs.json").vectors[0],
    transcript = fixture("transcript-v0.json").vectors[0];
  const payer = Keypair.fromSeed(Buffer.alloc(32, 9)),
    program = Keypair.fromSeed(Buffer.alloc(32, 10)).publicKey;
  const protocol = fromHex(transcript.transcript.protocolID),
    device = fromHex(transcript.transcript.deviceID),
    proof = fromHex(vector.proofBytes);
  const instruction = submitObservation(
    program,
    payer.publicKey,
    protocol,
    device,
    Buffer.alloc(32, 17),
    Buffer.alloc(32),
    proof,
  );
  assert.equal(instruction.data.length, 552);
  assert.ok(instruction.data.subarray(8, 488).equals(proof));
  const addresses = observationAddresses(
    program,
    protocol,
    device,
    42,
    proof.subarray(384, 416),
  );
  assert.ok(instruction.keys[4]!.pubkey.equals(addresses.commitment));
  assert.ok(instruction.keys[5]!.pubkey.equals(addresses.deviceEpoch));
  const digest = Buffer.alloc(32, 1),
    signer = Keypair.fromSeed(Buffer.alloc(32, 7));
  const ed = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: signer.secretKey,
    message: digest,
  });
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 299999 }),
    ed,
    instruction,
  );
  transaction.sign(payer);
  assert.throws(()=>transaction.serialize(),/too large/);
  const lookup = new AddressLookupTableAccount({ key:Keypair.generate().publicKey,state:{
    deactivationSlot:0xffff_ffff_ffff_ffffn,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,
    addresses:instruction.keys.filter(k=>!k.isSigner).map(k=>k.pubkey) } });
  const versioned = new VersionedTransaction(new TransactionMessage({ payerKey:payer.publicKey,
    recentBlockhash:PublicKey.default.toBase58(), instructions:transaction.instructions }).compileToV0Message([lookup]));
  versioned.sign([payer]);
  assert.ok(versioned.serialize().length <= 1232);
  const bad = Buffer.from(proof);
  bad.fill(255, 352, 384);
  assert.throws(
    () =>
      submitObservation(
        program,
        payer.publicKey,
        protocol,
        device,
        Buffer.alloc(32),
        Buffer.alloc(32),
        bad,
      ),
    /input/,
  );
});
test("DEV-35: account layouts, canonical scalar fields and extended epoch frontier", () => {
  const vector = fixture("dev35-proofs.json").vectors[0],
    data = Buffer.alloc(214);
  discriminator("account", "ObservationCommitment").copy(data);
  data.fill(1, 8, 72);
  data.writeUInt32LE(42, 72);
  Buffer.from(
    BigInt(vector.public[4]).toString(16).padStart(64, "0"),
    "hex",
  ).copy(data, 76);
  Buffer.from(
    BigInt(vector.public[5]).toString(16).padStart(64, "0"),
    "hex",
  ).copy(data, 108);
  data[140] = 1;
  data.writeBigInt64LE(1n, 206);
  assert.equal(decodeObservationCommitment(data).epoch, 42);
  assert.equal(decodeObservationCommitment(data).slotPaid, false);
  const malformed = Buffer.from(data);
  malformed.fill(255, 76, 108);
  assert.throws(() => decodeObservationCommitment(malformed), /fields/);
  const info = Buffer.concat([
    discriminator("account", "ObservationVerifierInfo"),
    fromHex(DEFAULT_OBSERVATION_KEY_DIGEST),
    Buffer.from([2, 7]),
  ]);
  assert.equal(
    decodeObservationVerifier(info).keyDigest,
    DEFAULT_OBSERVATION_KEY_DIGEST,
  );
  info[41] = 6;
  assert.throws(() => decodeObservationVerifier(info));
  const epoch = Buffer.alloc(587);
  discriminator("account", "DeviceEpoch").copy(epoch);
  epoch.writeUInt16LE(2, 8);
  assert.equal(decodeDeviceEpoch(epoch).frontier?.length, 16);
  assert.equal(decodeDeviceEpoch(epoch).independentObservers, 2);
});
