# DEV-35 — trusted observation registration

`submit_observation` registers an observation only after the configured verifier's
Ed25519 authorization and a seven-input Groth16 proof pass. Its relayer is any
fee payer. The signing verifier and fee payer use separate keys.

## Trusted circuit and registries

The program compiles a single observation verification key in `trusted_vk.rs`.
There is no caller-selected key account or key argument in this instruction.
`initialize_observation_verifier`, signed by the deployment's enrollment authority,
publishes its canonical key digest and ABI version at `["observation-verifier"]`.
The digest is SHA-256 of `Pathnod/groth16-key/v0` plus the 960-byte DEV-15 key
encoding. The verifier checks that its configured key matches this metadata when
signing is enabled. The production adapter also checks it at startup.

The checked-in key and proofs are public development fixtures from the existing
single-machine DEV-13 setup. They are suitable for the hackathon tests, not a
production ceremony. A production deployment must compile the intended trusted
key and configure the matching prover/verifier artifacts. Regenerate the public
Rust constant with:

```sh
node packages/solana/scripts/dev35-trusted-key.mjs /path/to/public-verification-key.json /path/to/isolated/programs/pathnod/src/trusted_vk.rs
```

Protocol/device PDAs and their owners/discriminators are checked by Anchor.
Both ID field values are recomputed with the native BN254 Poseidon syscall,
using the shared big-endian 128-bit splitting and domains 3/4. All seven public
inputs must be canonical Fr; epoch is u32 and class is 1–3. The root must have a
published `ObserverRoot` account and belong to the enrollment authority's active
four-root window. Epoch is within the same ±600-second boundary window as the
verifier, including legitimate epoch transitions.

## Authorization and instruction ABI

The immediately preceding instruction must be a self-contained Ed25519 precompile
with one signature, the configured verifier key and the expected 32-byte digest.
Offsets use the canonical web3.js layout and self-reference indices `0xffff`.
The Instructions sysvar address is constrained; the consuming instruction must
be top-level `submit_observation`, so an unrelated instruction/CPI cannot supply
the authorization. Budget instructions go before Ed25519, preserving adjacency.

Absent evidence retains the exact DEV-34 v0 digest. Nonzero evidence hashes use
v1 to authenticate the separately stored hash:

```text
SHA-256("Pathnod/verified/v1" || transcript_hash32 || evidence_hash32
        || nullifier32 || pseudonym32 || class:u8 || policy_version:u32LE)
```

Changing evidence without reauthorization is rejected. A zero evidence hash uses
v0; this preserves existing DEV-34 signatures/queue rows for absent evidence.
Previously signed nonzero-evidence v0 jobs cannot authorize this ABI and require
explicit operator handling.

Instruction data is the eight-byte Anchor discriminator followed by:

```text
A_negated[64] || B_c1_c0[128] || C[64] || public[7][32]
|| transcript_hash[32] || evidence_hash[32]
```

The nine account metas are protocol, device, enrollment authority, observer root,
observation commitment, device epoch, Instructions sysvar, relayer and System.
With the compute-budget and Ed25519 instructions, a signed legacy transaction is
1,207 bytes; no address lookup table or transaction split is required.

## Commitment and epoch accounting

`ObservationCommitment` is 214 bytes including its discriminator and is created
at `["obs", nullifier]`. It stores the spec's IDs, epoch, nullifier, pseudonym,
class, transcript/evidence hashes, paid flag and submission time. Duplicate
nullifiers fail with `E_NULLIFIER` (6001), including submissions from another payer.
Failed instructions roll back rent allocation, counts and tree changes.

`DeviceEpoch` retains the original 75-byte counter/root prefix and appends a
16-level frontier (587 bytes total). SDK decoding supports the 75-byte legacy
read fixture as well as the extended ABI. Each accepted nullifier increments
`independent_observers`, up to 65,535 per device/epoch. The fixed-depth SHA-256
Merkle tree is independently reproducible:

- Empty leaf: SHA-256(`Pathnod/observation-empty/v0`).
- Observation leaf: SHA-256(`Pathnod/observation-leaf/v0` || transcript_hash).
- Parent: SHA-256(`Pathnod/observation-node/v0` || left32 || right32).

Shared full-tree vectors verify frontier carries. Paid-slot accounting, reward
transfers, payout claims and policy rotation are DEV-36; paid counters/flags
remain zero/false. Confidence aggregation is not performed by this instruction.

The DEV-16 benchmark now uses `submit_observation_spike`, `SpikeObservationCommitment`
and `["dev16-obs", nullifier]`, isolating caller-selected test keys from the
production namespace. Use a fresh deployment; historical DEV-16 accounts at the
old namespace are not migrated by this change.

## Worker configuration

Keep the DEV-33 policy, trusted VK and DEV-34 signer configuration. Add:

```sh
PATHNOD_OBSERVATION_RELAYER_PAYER=/absolute/private/relayer-keypair.json
```

The file must be a bounded private Solana keypair, separate from the verifier.
This explicitly enables the concrete adapter and a two-second worker tick.
Shutdown awaits the worker before closing its database. Without a payer, signing
and durable queueing retain their existing behaviour; without signing, the
DEV-33 policy-only mode remains available.

`validated` receipts describe policy validation, not a transaction outcome.
Worker status reports confirmed only after finalized signature execution and a
fully matched commitment, or after finding the already-finalized matching
commitment from another relayer. In the latter case it clears an unproven local
transaction signature instead of attaching an unrelated explorer link.
Current paid status stays false. Real envelopes and private keys never enter the
on-chain payload or public test reports.

## Validation harness

The harness uses explicit public synthetic credentials/device keys and genuine
Mopro proofs and P256 signatures. It injects synthetic enrollment in its test
database; it does not establish Apple certificate attestation or physical BLE.
It is restricted to a local validator or official devnet and a disposable program.

```sh
pnpm --filter @pathnod/verifier observations:verify \
  --rpc http://127.0.0.1:18899 --wallet /tmp/test-wallet.json \
  --program DISPOSABLE_PROGRAM --database /tmp/dev35-policy.sqlite \
  --report /tmp/dev35-report.json
```

Use `--publisher-wallet` when an existing enrollment authority has a separate
signer, as in CI. CI runs this after registry/root/eligibility integration.
The harness tests genuine policy acceptance → atomic signing/queueing → real
consumer execution → finalized adapter confirmation, lost-response restart,
external submission, two observers, v1 evidence, duplicate rejection, native
Merkle roots, wrong authorization, malformed fields/proofs and inactive roots.
Private test databases/reports stay outside Git.

## Recorded validation — 2026-10-07

- Node 24.21.0 / pnpm 11.27.1: SDK 11 tests; verifier 67 passed, 2 optional tests
  skipped; build/typecheck passed.
- Rust workspace tests, formatting and Clippy passed. The program's 11 library
  tests include shared proof/key/tree vectors and instruction introspection.
- Swift packages: 149 tests passed; unsigned iOS app build passed.
- SBF build: 400,472-byte application, with no stack-frame overflow diagnostic.
- Local validator and real devnet: two independent synthetic observations,
  1,207-byte transactions, 169,573 CU for the first observation and 161,417 CU
  for the second. Counts/tree matched the independent reference; paid slots
  stayed zero.
- Both runs verified lost-RPC-response restart, external-relayer reconciliation,
  v1 evidence, duplicate rejection without counter/tree changes, altered hashes,
  missing/reordered Ed25519 instructions, wrong verifier, corrupted Groth16 proof,
  noncanonical fields, oversized epoch, wrong registered device and inactive root.
- Additional devnet simulations rejected an unregistered device and a substituted
  Instructions sysvar before execution; both checks are included in the CI harness.

The disposable devnet program is
`BtSHAidZ2Mr8PxnerKrsVwhMRq64kJoy9a11pdxjRZmk`. Public synthetic submissions:

- [Worker submission](https://explorer.solana.com/tx/mg3fwKrV1gXrAtZ6weZK1RnrfZYMEburyjb77G98kGRbNDFHHHQaJzHKt822oZEzakoZNY3u7KQnKUycg3ZPCGa?cluster=devnet).
- [Independent relayer submission with evidence](https://explorer.solana.com/tx/4mXybgeP8YTak1qm46qmsRzS6HzbPFWVjK6CyQRe8fw6PrSALii1KaLnDKJaF5DcQvNNRyB75SaBotzKcvSHFzim?cluster=devnet).

### Physical iPhone + ESP32

The isolated test app used the production capture, Mopro prover, App Attest
client and persistent outbox against the local verifier backed by real devnet.
Apple enrollment and root publication succeeded for a fresh test installation.
The ESP32 firmware was left unchanged.

- Three physical signatures verified; median RTT 38 ms; five RSSI samples.
- Real mobile proof and Apple assertion: 0.594 s.
- The server accepted the canonical envelope and the actual worker finalized its
  observation on devnet: 1,207 bytes and 153,063 CU.
- The class-1 commitment and independently reconstructed epoch tree matched;
  independent observers = 1, paid slots = 0, slot paid = false.
- The phone deliberately lost the successful HTTP receipt and retained the exact
  envelope in its persistent outbox for the restart/retry check.
- After restarting both server and app, the identical retry returned the existing
  validation, cleared the phone's queue and kept exactly one confirmed chain
  observation with the same signature, count and tree root.
- [Physical observation transaction](https://explorer.solana.com/tx/3uuCMr8hbbeZfvdb9qXxAHVnxgid2kPMxtb4c1NfinvA3hDr7CrXdvDcBEQqQovEnptaDjsUfoNVNirtEYy63QXU?cluster=devnet).

The test-only app shell, Apple key ID, real envelope, private databases and
development signing/proving files remain outside Git.
