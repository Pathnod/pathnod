import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { discriminator, observationAddresses } from "@pathnod/solana";
import { validateConfidenceCommitment } from "../src/confidence-chain.ts";
import {
  decodeObservationTranscript,
  encodeObservationTranscript,
  observationTranscriptHash,
} from "../src/observation-transcript.ts";
function fixture() {
  const v = JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/observations/transcript-v0.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).vectors[0];
  const t = decodeObservationTranscript(Buffer.from(v.bytes.slice(2), "hex")),
    program = new PublicKey("5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd");
  const data = Buffer.alloc(214);
  discriminator("account", "ObservationCommitment").copy(data);
  Buffer.from(t.protocolID).copy(data, 8);
  Buffer.from(t.deviceID).copy(data, 40);
  data.writeUInt32LE(t.epoch, 72);
  Buffer.from(t.nullifier).copy(data, 76);
  Buffer.from(t.pseudonym).copy(data, 108);
  data[140] = t.observerClass;
  observationTranscriptHash(t).copy(data, 141);
  Buffer.from(t.evidenceHash).copy(data, 173);
  data.writeBigInt64LE(1n, 206);
  const account: AccountInfo<Buffer> = {
    data,
    executable: false,
    owner: program,
    lamports: 1,
  };
  const input = {
    transcript: encodeObservationTranscript(t).toString("base64"),
    reenrollmentCount: null,
    ...(v.evidence === null
      ? {}
      : {
          evidence: Buffer.from(v.evidence.slice(2), "hex").toString("base64"),
        }),
  };
  const device = {
    deviceId: Buffer.from(t.deviceID),
    key: Buffer.from(t.publicKey),
    curve: t.curve,
    externalAsset: null,
    linked: false,
    registeredAt: 1n,
    capabilities: 2,
    claimedGeohash: null,
  };
  const address = observationAddresses(
    program,
    t.protocolID,
    t.deviceID,
    t.epoch,
    t.nullifier,
  ).commitment;
  return { program, address, account, input, device, t };
}
test("DEV-39 audit binds finalized commitment PDA, owner, transcript fields and registered device key", () => {
  const f = fixture();
  validateConfidenceCommitment(
    f.program,
    f.address,
    f.account,
    f.input,
    f.device,
  );
  assert.throws(
    () =>
      validateConfidenceCommitment(
        f.program,
        PublicKey.default,
        f.account,
        f.input,
        f.device,
      ),
    /binding/,
  );
  assert.throws(
    () =>
      validateConfidenceCommitment(
        f.program,
        f.address,
        { ...f.account, owner: PublicKey.default },
        f.input,
        f.device,
      ),
    /owner/,
  );
  assert.throws(
    () =>
      validateConfidenceCommitment(f.program, f.address, f.account, f.input, {
        ...f.device,
        key: Buffer.alloc(32),
      }),
    /binding/,
  );
});
test("DEV-39 audit rechecks signatures even when the modified transcript hash matches its account", () => {
  const f = fixture();
  const signature = f.t.challenges[0]!.signature;
  signature[0] = signature[0]! ^ 1;
  f.input.transcript = encodeObservationTranscript(f.t).toString("base64");
  observationTranscriptHash(f.t).copy(f.account.data, 141);
  assert.throws(
    () =>
      validateConfidenceCommitment(
        f.program,
        f.address,
        f.account,
        f.input,
        f.device,
      ),
    /signature/,
  );
});
