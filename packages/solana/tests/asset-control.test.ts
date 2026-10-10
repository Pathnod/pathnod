import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  cnftAssetId,
  cnftLeaf,
  assetControlDigest,
  encodeControlProof,
  registerDevice,
  ACCOUNT_COMPRESSION_V1,
  cnftTreeConfig,
  type CnftControlProof,
  type DeviceArgs,
} from "../src/index.ts";
const vector = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/assets/bubblegum-control-v0.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function fixture() {
  const p = vector.proof;
  const proof: CnftControlProof = {
    tree: new PublicKey(p.tree),
    owner: new PublicKey(p.owner),
    delegate: new PublicKey(p.delegate),
    nonce: BigInt(p.nonce),
    index: p.index,
    root: Buffer.from(p.root, "hex"),
    dataHash: Buffer.from(p.dataHash, "hex"),
    creatorHash: Buffer.from(p.creatorHash, "hex"),
    expiresAt: BigInt(p.expiresAt),
    nodes: [],
  };
  const args: DeviceArgs = {
    deviceId: Buffer.from(vector.deviceID, "hex"),
    key: Buffer.from(vector.deviceKey, "hex"),
    curve: 1,
    capabilities: 42,
    externalAsset: new PublicKey(vector.asset),
    claimedGeohash: null,
    proofOfControl: proof,
  };
  return {
    program: new PublicKey(vector.program),
    requester: new PublicKey(vector.requester),
    protocol: Buffer.from(vector.protocolID, "hex"),
    proof,
    args,
  };
}
test("DEV-43 SDK matches the Rust compressed NFT codec, PDA, leaf and authorization vector", () => {
  const f = fixture();
  assert.equal(vector.publicTestVectors, true);
  assert.equal(
    cnftAssetId(f.proof.tree, f.proof.nonce).toBase58(),
    vector.asset,
  );
  assert.equal(cnftLeaf(f.proof).toString("hex"), vector.leaf);
  assert.equal(encodeControlProof(f.proof).toString("hex"), vector.proofBytes);
  assert.equal(
    assetControlDigest(f.program, f.requester, f.protocol, f.args).toString(
      "hex",
    ),
    vector.digest,
  );
});
test("DEV-43 registration encodes the proof and trusted CPI context while preserving the legacy no-proof ABI", () => {
  const f = fixture(),
    ix = registerDevice(f.program, f.requester, f.protocol, f.args);
  assert.equal(ix.keys.length, 8);
  assert.ok(ix.keys[4]!.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY));
  assert.ok(ix.keys[5]!.pubkey.equals(f.proof.tree));
  assert.ok(ix.keys[6]!.pubkey.equals(cnftTreeConfig(f.proof.tree)));
  assert.ok(ix.keys[7]!.pubkey.equals(ACCOUNT_COMPRESSION_V1));
  assert.equal(ix.data[106], 1);
  assert.equal(ix.data.readUInt32LE(107), 213);
  assert.equal(ix.data.subarray(111, 324).toString("hex"), vector.proofBytes);
  const { proofOfControl: _proof, ...plain } = f.args;
  const unlinked = registerDevice(f.program, f.requester, f.protocol, plain);
  assert.equal(unlinked.keys.length, 4);
  assert.equal(unlinked.data[106], 0);
  assert.equal(unlinked.data.length, 112);
});
test("DEV-43 authorization binds scope, expiry and registration metadata; malformed proofs cannot be built", () => {
  const f = fixture(),
    original = assetControlDigest(f.program, f.requester, f.protocol, f.args);
  for (const args of [
    { ...f.args, capabilities: 43 },
    { ...f.args, claimedGeohash: "u09tvw" },
    {
      ...f.args,
      proofOfControl: { ...f.proof, expiresAt: f.proof.expiresAt + 1n },
    },
  ])
    assert.notDeepEqual(
      assetControlDigest(f.program, f.requester, f.protocol, args),
      original,
    );
  assert.notDeepEqual(
    assetControlDigest(PublicKey.default, f.requester, f.protocol, f.args),
    original,
  );
  assert.notDeepEqual(
    assetControlDigest(f.program, PublicKey.default, f.protocol, f.args),
    original,
  );
  assert.throws(
    () =>
      registerDevice(f.program, f.requester, f.protocol, {
        ...f.args,
        externalAsset: PublicKey.default,
      }),
    /does not match/,
  );
  assert.throws(
    () => encodeControlProof({ ...f.proof, index: 2 ** 30 }),
    /Invalid/,
  );
  assert.throws(
    () => encodeControlProof({ ...f.proof, nonce: -1n }),
    /Invalid/,
  );
  assert.throws(
    () => encodeControlProof({ ...f.proof, expiresAt: 2n ** 63n }),
    /Invalid/,
  );
});
