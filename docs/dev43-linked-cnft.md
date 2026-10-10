# DEV-43 — compressed NFT control at registration

DEV-43 implements roadmap A3.11 with a Bubblegum v1 compressed NFT adapter.
`register_device` can set `linked=true` after verifying the leaf owner's
authorization and current on-chain membership. The demonstration NFT is
explicitly a devnet asset; it does not establish Helium affiliation, service,
coverage or device location.

## Verification boundary

The adapter pins Bubblegum
`BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY` and SPL Account Compression
`cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK`.

It verifies:

1. The external asset is the Bubblegum PDA derived from `"asset"`, the tree and
   the little-endian u64 leaf nonce. An asset PDA is not treated as a signing key.
2. The tree belongs to the pinned Compression program and its header authority
   is the expected Bubblegum TreeConfig PDA. That config must belong to Bubblegum
   and have the supported v1 layout/version and matching capacity/mint bounds.
   An arbitrary compression tree or caller-selected owner is insufficient.
3. The immediately preceding, self-contained Ed25519 precompile verifies the
   actual leaf owner's signature over a domain-separated registration digest.
   The consumer must be the top-level Pathnod `register_device` instruction.
4. The authorization is unexpired and no more than 600 seconds ahead of the
   on-chain clock. The CLI reads the Clock sysvar when creating it.
5. A readonly CPI to Compression `verify_leaf` validates the leaf and its proof
   against the current tree, including its changelog handling. A proof whose
   owner changed cannot authorize the old owner merely because an old root is
   still in the buffer.

The leaf is the canonical v1 Keccak hash of version, asset ID, owner, delegate,
nonce, metadata data hash and creator hash. Reference interfaces are documented
in [Bubblegum's leaf schema](https://github.com/metaplex-foundation/mpl-bubblegum/blob/main/programs/bubblegum/program/src/state/leaf_schema.rs)
and [Compression's verification implementation](https://github.com/solana-labs/solana-program-library/blob/master/account-compression/programs/account-compression/src/lib.rs).

`linked` is a control snapshot at registration. It is not automatically cleared
on a later NFT transfer and must not be presented as continuing ownership.
The adapter requires the owner, rather than an arbitrary delegate, to authorize
the registration. Other proof versions, Bubblegum v2 and DePHY DID formats are
unsupported and fail closed until their own adapters are implemented.

## Proof and authorization encoding

The existing `proof_of_control: Option<Vec<u8>>` field carries exactly 213 bytes:

```text
adapter = 1:u8
tree:Pubkey32 || owner:Pubkey32 || delegate:Pubkey32
|| nonce:u64LE || index:u32LE || root32 || data_hash32 || creator_hash32
|| expires_at:i64LE
```

Merkle nodes are readonly remaining accounts after the Instructions sysvar,
tree, TreeConfig and executable Compression program. Canopy completion is
performed by the native Compression verification instruction.

The owner signs this 32-byte digest:

```text
SHA-256("Pathnod/asset-control/v0"
  || program32 || requester32 || protocol_id32 || device_id32 || k_dev32
  || curve:u8 || external_asset32 || capabilities:u32LE
  || claimed_geohash6:borsh-option || proof_of_control213)
```

The signature binds the deployment/program, requester, protocol, device key/ID,
asset, declared metadata and full proof context. It does not certify the declared
geohash as a physical position. The proof codec and digest share the public
[Rust/TypeScript vector](../fixtures/assets/bubblegum-control-v0.json).

Registration without a proof still uses the original four accounts and exact
argument encoding, records an optional external reference, and writes
`linked=false`. `DeviceRegistry` remains 126 bytes; historical registry,
observation, payment and confidence account layouts are unchanged.

## Reproducible demonstration

Use a signed Mopro app and the actual 70-byte INFO of the physical ESP32. Keep
wallets, signed journals, generated builds and state outside Git in a private
directory. A config file must have permissions 600:

```json
{
  "version": 1,
  "rpc": "https://api.devnet.solana.com",
  "program": "<deployed compatible Pathnod program>",
  "wallet": "/absolute/private/requester.json",
  "stateDirectory": "/absolute/private/linked-asset-state",
  "deviceInfo": "<140 hex characters from actual ESP32 INFO>"
}
```

The tool accepts official devnet or an explicitly configured local validator
with its expected genesis. It requests no faucet. It preserves a tree key and
signed transaction journals before sending. Steps run under a process lock.
Inspect a stale lock's PID before removing it; preserve the journal.

```sh
make linked-asset-prepare LINKED_ASSET_CONFIG=/absolute/private/linked-asset.json
make linked-asset-mint LINKED_ASSET_CONFIG=/absolute/private/linked-asset.json
make linked-asset-register LINKED_ASSET_CONFIG=/absolute/private/linked-asset.json
make linked-asset-report LINKED_ASSET_CONFIG=/absolute/private/linked-asset.json
```

Prepare sends no transaction. Mint creates a small depth-3/buffer-8 Bubblegum
tree and one real compressed NFT, with clearly labelled demo metadata. The tool
reconstructs the complete small-tree proof and checks its root against the tree
account; it does not require a DAS indexer. The demonstration does not pretend
to support proof discovery for arbitrary large trees.

Register creates separate linked and unlinked-control protocol scopes using the
same physical device ID/key. This preserves the existing Gate 2/DEV-41 observations
and payouts. The final report verifies the finalized registry account's owner,
key, asset and `linked` flag and emits public fields/transaction references only.

Retries inspect signature history before resending identical signed bytes while
valid. Previously observed finalized outcomes are archived in the private
journal and can be recovered without another send; the actions still check the
actual resulting accounts. An expired prepared transaction with an unknown
outcome stops for inspection. The tool never silently generates a replacement.
The demonstration NFT URI points to the committed public
[demo metadata](evidence/dev43-demo-cnft-metadata.json).

## Local adversarial gate

The CI validator clones the actual devnet Bubblegum, Compression and Noop
programs. It mints a real local cNFT and exercises both registration modes, then:

| Test | Required rejection |
| --- | --- |
| Wrong leaf owner, with a valid signature from that wrong key | Compression membership failure |
| Wrong metadata data hash | Compression membership failure |
| Changed registration metadata after authorization | Pathnod `InvalidAssetControlAuthorization` / 6120 |
| Expired authorization | Pathnod `ExpiredAssetControlProof` / 6121 |
| Authorization too far in the future | Pathnod `ExpiredAssetControlProof` / 6121 |
| Missing preceding owner precompile | Pathnod `InvalidAssetControlAuthorization` / 6120 |
| Swapped TreeConfig/provenance account | Pathnod `InvalidExternalAssetProof` / 6119 |
| Old owner/root after an actual Bubblegum transfer | Compression membership failure |

Compression reports its own `ConcurrentMerkleTreeError` / 6001. The harness
requires the failing Compression program ID in the transaction logs; a numeric
6001 alone does not identify this failure and is not Pathnod's E_NULLIFIER.
Every failed registration must leave its DeviceRegistry absent.

The Rust/unit SDK tests also cover strict proof length/version, shared leaf/digest
encoding, asset PDA derivation, message-scope/metadata/expiry binding and legacy
no-proof compatibility. Local-validator results are separate from the physical
devnet record.

## Hardware and devnet record — 2026-10-10

The [public validation record](evidence/dev43-linked-device-devnet.json) contains
account addresses, finalized transaction references, build hashes and measured
results. Private signed wire, asset owner keys, provisioning data, device storage
and captures are excluded from Git.

- Actual Bubblegum v1 demo asset: `G2ereCM7yq9SjzVfzcBpPGT8LEhnE4CgQiHY23f3u9Ms`.
- [Linked DeviceRegistry on Explorer](https://explorer.solana.com/address/2gLbtXJoncx3ZekMEkZuwBdSu6X8LgLcsDi4Dmx7TrnZ?cluster=devnet):
  `linked=true`, the actual asset reference, unchanged ESP32 key/ID and capabilities
  `0x2a`. The report independently checks the account owner, exact allocation,
  key, device ID, curve, capabilities and asset.
- [Finalized linked registration](https://explorer.solana.com/tx/2B4Ca876uYrUFkq7EeqN6CifXCXeiWJ2UvxqsULBiFY6AVLdADm9wLs3gP5QB4cXQmQpyYHdAWMoCRcXWTDzA5qg?cluster=devnet):
  980-byte signed transaction, 45,860 CU. The separate registration without a
  control proof remains `linked=false`.
- Program binary: 548,240 bytes; compared byte-for-byte with finalized devnet
  ProgramData after the compatible upgrade.
- The canonical IDL is published in Program Metadata account
  `ASDk1UwertpJzvcbaN1qesYdoyKLjs3wE7aMHGeUvGb7`; fetching it at finalized
  commitment returns the exact built DEV-43 IDL for the live program. This
  exposes the `DeviceRegistry` schema for Explorer/client decoding.
- Physical ESP32-C3: ESP-IDF v5.5.1, demo Helium profile, 589,488-byte application
  image. Only the application partition was flashed; identity/counter NVS was
  preserved. INFO now announces the asset bytes
  `df4bb040d8cf9e006693e7671c0d6904033b39d0a0382e4e1b2d3c9ad7440fda`.
- Physical iPad Air M2, iPadOS 27.0.1: the operator ran **Start three challenges**
  in the existing signed app and confirmed three verified responses, counters
  **897, 898, 899**, notification RTT median **58.5 ms**, and the exact new hint.
  This is the iPad's reported BLE validation; no new enrollment or observation
  submission was needed for this registration task.
- Historical compatibility: independently reread the original DEV-41 protocol
  after the upgrade. Its three observations, three paid slots, full observation
  root, escrow, fee vault and all three payouts match the before-upgrade audit.
- Automated gates: 20 program unit tests, 19 SDK tests, 133 verifier tests passed
  (two existing verifier skips), workspace tests, SDK/verifier builds, formatting,
  Clippy and dependency audits. The cloned-program local validator accepted both
  registration modes and rejected all eight adversarial cases above, including a
  stale owner after a real transfer.

The device's hint is an announcement; it is not included in DEV_MSG_V0 and the
firmware does not verify the chain itself. The registry control proof establishes
the device-to-asset authorization at registration. This demo asset has no Helium
network affiliation. `linked=true` remains a snapshot after a later transfer.
