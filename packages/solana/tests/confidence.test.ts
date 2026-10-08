import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  confidenceAuthorizationDigest,
  confidenceAuthorizationBytes,
  publishConfidence,
} from "../src/confidence.ts";
const v = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/confidence/authorization-v0.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const program = new PublicKey(Buffer.from(v.programBytes, "hex")),
  protocol = Buffer.from(v.protocolID, "hex"),
  device = Buffer.from(v.deviceID, "hex");
const args = {
  epoch: v.epoch,
  observationRoot: v.observationRoot,
  observerCount: v.observerCount,
  previousCommitment: v.previousCommitment,
  commitment: v.commitment,
  policyVersion: v.policyVersion,
  evaluatedAtMilliseconds: BigInt(v.evaluatedAtMilliseconds),
};
test("DEV-39 confidence authorization matches the independent SHA-256 vector and binds every field", () => {
  assert.equal(v.publicSyntheticTests, true);
  assert.equal(
    confidenceAuthorizationDigest(program, protocol, device, args).toString(
      "hex",
    ),
    v.sha256,
  );
  for (const changed of [
    { ...args, epoch: 43 },
    { ...args, observerCount: 4 },
    { ...args, previousCommitment: "00".repeat(32) },
    { ...args, commitment: "00".repeat(32) },
    { ...args, policyVersion: 8 },
    { ...args, evaluatedAtMilliseconds: args.evaluatedAtMilliseconds + 1n },
  ]) {
    assert.notEqual(
      confidenceAuthorizationDigest(
        program,
        protocol,
        device,
        changed,
      ).toString("hex"),
      v.sha256,
    );
  }
  assert.notEqual(
    confidenceAuthorizationDigest(
      new PublicKey(Buffer.alloc(32, 9)),
      protocol,
      device,
      args,
    ).toString("hex"),
    v.sha256,
  );
  assert.throws(() =>
    confidenceAuthorizationBytes({ ...args, observerCount: 65536 }),
  );
  assert.throws(() => confidenceAuthorizationBytes({ ...args, epoch: -1 }));
});
test("DEV-39 instruction uses the exact protocol/device/epoch PDAs and only writes DeviceEpoch", () => {
  const ix = publishConfidence(program, protocol, device, args);
  assert.equal(ix.keys.length, 4);
  assert.equal(ix.data.length, 8 + 114);
  assert.equal(ix.keys.filter((k) => k.isWritable).length, 1);
  assert.equal(ix.keys.filter((k) => k.isSigner).length, 0);
  const epoch = Buffer.alloc(4);
  epoch.writeUInt32LE(42);
  assert.ok(
    ix.keys[2]!.pubkey.equals(
      PublicKey.findProgramAddressSync(
        [Buffer.from("epoch"), protocol, device, epoch],
        program,
      )[0],
    ),
  );
});
