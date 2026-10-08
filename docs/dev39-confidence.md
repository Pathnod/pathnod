# DEV-39 — deterministic confidence snapshots

DEV-39 implements Spec §8 with an explicit initial policy. Its six scores are
signals about verified observations. They do not prove GPS coordinates, a unique
human or the absence of a local relay. The requester dashboard is DEV-40.

## Policy v0

Scores use integer basis points, 0–10,000. Division rounds down. The report
contains the complete policy, scope, evaluation time, native observation tree
order and a hash of its input history. No wall clock is read inside the scoring
function. The history window is the preceding 30 days; the complete target epoch
is included even when it is older than that window.

| Facet | Deterministic calculation |
| --- | --- |
| Hardware confidence | Class 1/2 = 10,000; class 3 = 8,000. A known reenrollment count reduces this by dividing by `1 + floor(count / 3)`. Each merged group takes its least confident member; groups are averaged. |
| Temporal freshness | `max(0, 10,000 - floor(age_ms × 10,000 / epoch_ms))`. Each merged group uses its oldest observation, then groups are averaged. |
| Witness diversity | `min(10,000, floor(group_count × 2,000 / 3))`. The current registry has one requester authority per protocol and no authenticated per-device deployer identity; each group's contribution therefore stays at 0.2. Different device IDs never establish different deployers. |
| Spatial consistency | Each group supplies one geohash vote only if all its target observations include the same valid geohash and positive GPS accuracy. Vote quality is `max(0, 10,000 - floor(accuracy_m × 10,000 / 1,000))`, taking the least precise member. Modal vote quality is divided by all target groups, including missing votes. If a claimed geohash exists, average this result with agreement at that declared location. Cap at 5,000 below three merged groups. |
| Behavior diversity | Average normalized Shannon entropy of devices, UTC hours of day and included geohashes in the group's history. Entropy is divided by `log2(4)` and capped at 10,000; fewer than two samples score zero. Q24 logarithms use integer squaring, without platform-dependent floating-point logs. Missing location contributes zero to the location term. |
| Service evidence | No evidence = 0; hash-bound evidence in an unrecognized schema = 2,500 for presence alone. A `{"version":0,"type":"wifi","bssid_hash":"<64 lowercase hex>"}` payload scores 10,000 only if its nonzero hash matches the observer's Wi-Fi measurement. Groups use their least supported member, then are averaged. |

The six weights are respectively 25%, 10%, 30%, 15%, 15%, 5%. The report's
`score` is their weighted average. The initial `VERIFIED` label requires at
least three merged groups, witness diversity ≥5,000 and hardware confidence
≥8,000; otherwise it is `LOW`. This is a disclosed initial requester policy,
not an additional protocol guarantee or a location certificate.

Two pseudonyms are connected when their shared `(device, epoch)` slots divided
by the larger of their slot counts exceeds 80%, strictly. Connected components
are fused transitively. This conservative rule can merge sparse histories after
only one shared observation; v0 does not invent a minimum sample exemption.
History is always restricted to one protocol. Cross-protocol pseudonyms and
App Attest identifiers are never used to infer independence.

Apple App Attest does not give this implementation a stable unique-device
identifier across fresh keys/credentials. The current recorder marks the
reenrollment risk metric unavailable (`null`); it does not count ordinary tree
refreshes or repeat enrollment assertions as reenrollments. The scorer supports
authenticated risk metadata for future enrollment integrations and reports its
coverage. Missing risk data is distinct from a measured zero reenrollment count.

The v0 computation limits are 10,000 history records, 512 history pseudonyms and
98 registered devices per atomic registry batch. Exceeding a limit fails closed
instead of dropping observations or inflating a partial result.

## Canonical report and audit

The report is UTF-8 JSON with object keys sorted lexicographically at every
level, arrays in their declared order, and safe integers only. The history is
sorted by transcript hash; the native epoch insertion order remains explicit.
Commitment domains are:

```text
inputsHash = SHA-256("Pathnod/confidence-inputs/v0" || canonical(input_history))
confidence_commitment = SHA-256("Pathnod/confidence/v0" || canonical(report))
```

The chain reader obtains all finalized `ObservationCommitment` accounts for the
protocol, then a registry/epoch snapshot at least as recent as that bank. Every
encrypted transcript must match its commitment PDA, protocol/device/epoch,
nullifier, pseudonym, class and transcript/evidence hashes. Registered key/curve,
domain-separated device ID and all three device signatures are checked again.
The complete target count and independently reconstructed native epoch tree
must match `DeviceEpoch`. A concurrent change fails validation and requires a
fresh calculation. Missing authenticated history is not silently ignored.

When submission timestamps tie, the reader's proposed order may not reproduce
the native root. Supply `transcriptOrder` explicitly in that case. The root
check is authoritative; sorting timestamps alone is not evidence of chain order.

## Requester-encrypted history

Set `PATHNOD_CONFIDENCE_RECIPIENT` to a bounded X25519 public-key PEM file when
starting the production verifier. Validated transcripts and optional evidence
are recorded in the same SQLite transaction as counters, receipts and relay
jobs. The transcript contains approximate geohash6 only. Observer secrets,
App Attest key IDs and assertions are not copied into this archive.

Each record uses an ephemeral X25519 key exchange, HKDF-SHA256 with the
`Pathnod/confidence-encryption/v0` domain and AES-256-GCM. AEAD binds the
deployment/policy target and transcript hash. A different requester key cannot
silently reuse the archive. The requester private key is used by the operator's
CLI only, outside Git; it is not needed by the HTTP server.

Without a recipient key, observation validation continues normally and no raw
transcript archive is created. Confidence calculation then requires importing
authenticated historical inputs. Historical import accepts only transcripts
whose canonical hash already has a policy receipt and a valid signed relay
payload. It cannot introduce unvalidated observations or invent enrollment risk
measurements. Chain validation remains mandatory before publication.

## On-chain publication

`publish_confidence` leaves the existing 587-byte DeviceEpoch layout unchanged.
It checks its config/device/epoch PDAs, current policy version, native observation
root/count and previous confidence hash. Its authorization is the immediately
preceding self-contained Ed25519 precompile for the configured verifier:

```text
SHA-256("Pathnod/confidence-authorization/v0"
  || program32 || protocol32 || device32 || epoch:u32LE
  || observation_root32 || observer_count:u16LE
  || previous_commitment32 || new_commitment32
  || policy_version:u32LE || evaluated_at_ms:u64LE)
```

The program accepts a nonzero commitment and an evaluation time no earlier than
the epoch and no more than 600 seconds ahead of the chain clock. It checks the
authorization at top level, with exact precompile layout and adjacency.
`StaleConfidence` is error 6118. A stale root/count/previous hash cannot overwrite
new state. A new accepted observation clears the confidence hash. Fee payer,
observation counters, native tree, paid slots and token balances are not changed
by publication. The configured verifier remains the phase-0 trust boundary for
the off-chain calculation; the hash makes the report auditable.

## Operator commands

Keep the config, requester private key, actual transcripts, encrypted database,
signed wire journal and reports in private directories outside Git.

```json
{
  "version": 1,
  "verifierConfig": "/absolute/private/demo/verifier-config.json",
  "requesterPrivateKey": "/absolute/private/requester-x25519.pem",
  "stateDirectory": "/absolute/private/confidence/run-1",
  "deviceID": "<64 lowercase hex>",
  "epoch": 2962,
  "transcriptOrder": ["<transcript hash in native insertion order>"],
  "importInputs": "/absolute/private/historical-inputs.json"
}
```

Historical inputs use `[{"transcript":"<base64 Borsh>","reenrollmentCount":null}]`
with optional base64 `evidence`. Do not include an envelope or App Attest key ID.

```sh
make confidence-import CONFIDENCE_CONFIG=/absolute/private/confidence.json
make confidence-compute CONFIDENCE_CONFIG=/absolute/private/confidence.json
make confidence-publish CONFIDENCE_CONFIG=/absolute/private/confidence.json
make confidence-status CONFIDENCE_CONFIG=/absolute/private/confidence.json
make confidence-report CONFIDENCE_CONFIG=/absolute/private/confidence.json
```

Compute writes `computed.json` without broadcasting. Publish rechecks its exact
inputs and evaluation time, then persists the signed transaction before sending.
Recovery checks finalized history before retransmitting identical bytes while
valid. An ambiguous expired transaction stops for inspection; it is not replaced
automatically. A finalized publication is verified against the epoch and stored
with its report. Preserve the journal and use a new run directory for a new
snapshot. No devnet faucet is invoked.

The CLI accepts official devnet only, or an explicitly selected local validator
with its actual genesis. The read-only HTTP route
`GET /devices/{device_id}/confidence?epoch={epoch}` serves the aggregate report
only while hash, native root/count and current policy still match the finalized
chain. Invalidated or rotated reports return `stale` with no active confidence;
missing reports return 404. Reports describe their stated evaluation time;
publish a new snapshot when current temporal freshness is needed.

## Validation

The shared authorization vector is public synthetic data, independently hashed
with Python's SHA-256, and checked by Rust and TypeScript. Scoring tests cover
80% boundaries, witness weights, spatial caps, missing signals, evidence
binding, protocol isolation, canonical hashes and requester encryption.
The local-validator harness adds authorized publications, wrong-verifier,
wrong-policy, stale-root and replay rejection, plus invalidation by a subsequent
observation. These are fixtures, not physical hardware evidence.

### Physical observation and devnet — 2026-10-08

I reused the real iPhone 16 Pro / ESP32-C3 Gate 2 session: three physical
signatures, actual Apple App Attest class 1 and the mobile Mopro proof. The
recovered phone capture reproduced the exact finalized transcript hash
`2978df43ea02d34035a79666f701de7239ce0e63a2708b7b3b96e86e1a321cb7`.
This is a historical hardware observation, not a new BLE session or a fixture.

I upgraded the disposable devnet demonstration program with the compatible
530,384-byte SBF binary. The existing VK digest, observation ABI and account
layouts were preserved. RPC throttling required resuming the same private
buffer through a temporary local rate limiter; no faucet or replacement
deployment was used.

- [Finalized program upgrade](https://explorer.solana.com/tx/4CgY4iHSHpN8BdDKUs7mSf7hrvJZ1ZKAKuaKnKVFo48yoKTKDv6k9ZXW7TgdH3rGkTgVps6ETPCYY7Ad9YTPFvqW?cluster=devnet).
- [Finalized confidence publication](https://explorer.solana.com/tx/4qHCDY5kzTGDLMoGZSccQY4PPfYE64J3EdqSfWpq6aX72SDqBJPySXd2DYHpi5aVTMzTTxpt6UNEgZUHzU8WajVw?cluster=devnet): **643 bytes**, **12,759 CU**, slot **508914171**.

The published confidence commitment is
`225f8a755b09c3354ae795f7e4c0b76a6e1719e3163001c83c98f5e036d37e1e`.
The fixed snapshot has facets **10,000 / 9,937 / 666 / 0 / 0 / 0** basis
points, weighted score **3,693 / 10,000** and status **LOW**. Only one witness
exists; location, behavior history and service evidence are unavailable, and
cross-deployer/reenrollment risk coverage remains explicitly unavailable.

I compared nine finalized accounts before and after the upgrade/publication.
Only DeviceEpoch's 32 confidence bytes changed. Its independent-observer count
and paid-slot count remained **1**, and its native observation root remained
`b8c54532cf7f23c1772c1895e570a69417a91ce4f961c5c8a12639f327dd1e56`.
The commitment, registry, protocol, payout, payment settings, escrow, fee vault
and payout vault data were unchanged. Gross/fees/available/escrow stayed at
**0.05 / 0.01 / 0.04 / 0.10 devnet USDC**; nothing was withdrawn.

I reran publication from the persisted journal and recovered the same finalized
signature without a new broadcast. The production local HTTP endpoint returned
`published` with the same hash, score and signature. Private phone captures,
X25519 keys, encrypted inputs, databases, account snapshots and signed wire
journals remain outside Git.
