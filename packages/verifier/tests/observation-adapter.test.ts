import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
} from "@solana/web3.js";
import { DEFAULT_OBSERVATION_KEY_DIGEST, discriminator } from "@pathnod/solana";
import { PathnodObservationSubmissionAdapter } from "../src/observation-adapter.ts";
import {
  ObservationSigner,
  authorizationDigest,
  authorizationInstruction,
  authorizationPreimage,
  verifyAuthorization,
  relayProofBytes,
} from "../src/observation-authorization.ts";
import type { ObservationRelayPayload } from "../src/observation-relay.ts";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/observations/${name}`, import.meta.url),
      "utf8",
    ),
  );
const bytes = (value: string) => Buffer.from(value.replace(/^0x/, ""), "hex");

test("DEV-35: evidence v1 is signed while absent evidence preserves DEV-34 v0", () => {
  const v0 = fixture("verifier-authorization-v0.json"),
    signer = new ObservationSigner(Buffer.alloc(32, 7));
  assert.equal(
    signer.sign({ ...v0, evidenceHash: "00".repeat(32) }),
    v0.signature,
  );
  const v1 = { ...v0, evidenceHash: "44".repeat(32) },
    signature = signer.sign(v1);
  const reference = fixture("verifier-authorization-v1.json");
  assert.equal(signature, reference.signature);
  assert.equal(authorizationDigest(v1).toString("hex"), reference.digest);
  assert.equal(authorizationPreimage(v1).toString("hex"), reference.preimage);
  assert.ok(verifyAuthorization(v1, signer.publicKey, signature));
  assert.ok(
    !verifyAuthorization(
      { ...v1, evidenceHash: "45".repeat(32) },
      signer.publicKey,
      signature,
    ),
  );
  assert.ok(!verifyAuthorization(v0, signer.publicKey, signature));
  assert.equal(
    authorizationPreimage(v1).subarray(0, 19).toString(),
    "Pathnod/verified/v1",
  );
  assert.ok(
    authorizationInstruction(v1, signer.publicKey, signature)
      .data.subarray(-32)
      .equals(authorizationDigest(v1)),
  );
});
test("DEV-35: real proof packing matches the native Rust verifier vectors", () => {
  for (const vector of fixture("dev35-proofs.json").vectors)
    assert.equal(
      relayProofBytes(vector.proof, vector.public).toString("hex"),
      vector.proofBytes,
    );
});
test("DEV-35: finalized commitment confirmation rejects mismatched fields, ownership and ABI/key", async () => {
  const program = Keypair.fromSeed(Buffer.alloc(32, 10)).publicKey,
    payer = Keypair.fromSeed(Buffer.alloc(32, 9));
  const proof = fixture("dev35-proofs.json").vectors[0],
    t = fixture("transcript-v0.json").vectors[0].transcript;
  const signer = new ObservationSigner(Buffer.alloc(32, 7));
  const payload: ObservationRelayPayload = {
    protocolID: t.protocolID.slice(2),
    deviceID: t.deviceID.slice(2),
    epoch: 42,
    transcriptHash: "11".repeat(32),
    evidenceHash: "00".repeat(32),
    nullifier: BigInt(proof.public[4]).toString(16).padStart(64, "0"),
    pseudonym: BigInt(proof.public[5]).toString(16).padStart(64, "0"),
    observerClass: 1,
    policyVersion: 1,
    proofBytes: proof.proofBytes,
    verifier: signer.publicKey,
    verifierSignature: "",
  };
  payload.verifierSignature = signer.sign(payload);
  const adapter = new PathnodObservationSubmissionAdapter(
      DEFAULT_OBSERVATION_KEY_DIGEST,
    ),
    record = Buffer.alloc(214);
  discriminator("account", "ObservationCommitment").copy(record);
  bytes(payload.protocolID).copy(record, 8);
  bytes(payload.deviceID).copy(record, 40);
  record.writeUInt32LE(42, 72);
  bytes(payload.nullifier).copy(record, 76);
  bytes(payload.pseudonym).copy(record, 108);
  record[140] = 1;
  bytes(payload.transcriptHash).copy(record, 141);
  record.writeBigInt64LE(1n, 206);
  let row: AccountInfo<Buffer> | null = {
    data: record,
    owner: program,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
  const connection = {
    getAccountInfo: async (_key: PublicKey, commitment: string) => {
      assert.equal(commitment, "finalized");
      return row;
    },
  } as unknown as Connection;
  assert.equal(await adapter.confirm(connection, program, payload), true);
  assert.equal(
    adapter.instruction(program, payer.publicKey, payload).data.length,
    552,
  );
  record[141] = record[141]! ^ 1;
  await assert.rejects(
    adapter.confirm(connection, program, payload),
    /Mismatched/,
  );
  record[141] = record[141]! ^ 1;
  row = { ...row!, owner: PublicKey.default };
  await assert.rejects(
    adapter.confirm(connection, program, payload),
    /Untrusted/,
  );
  row = null;
  assert.equal(await adapter.confirm(connection, program, payload), false);
  row = {
    data: Buffer.concat([
      discriminator("account", "ObservationVerifierInfo"),
      bytes(DEFAULT_OBSERVATION_KEY_DIGEST),
      Buffer.from([2, 7]),
    ]),
    owner: program,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
  await adapter.validateTarget(connection, program);
  row.data[8] = row.data[8]! ^ 1;
  await assert.rejects(adapter.validateTarget(connection, program), /mismatch/);
});
