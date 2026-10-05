# DEV-28 — batched observer-root publication

The DEV-26 enrollment server can publish its Poseidon tree through DEV-27's
`publish_root` instruction. Each accepted new enrollment commits the root,
revision and leaf count together in SQLite. Re-enrollment returns the current
path without adding a leaf or scheduling another publication.

## Batching and recovery

The worker checks for pending enrollments every second. By default it schedules
the latest root after **16 new leaves** or **30 seconds since the first
unpublished leaf**, whichever comes first. The delay triggers a publication
attempt; RPC availability and Solana finalization determine when it completes.
Intermediate roots within a batch are not published. A frozen pending snapshot
finishes before the worker schedules the next batch.

The enrollment database is the durable queue. Publication records contain the
snapshot, exact signed transaction, blockhash expiry, retry deadline and result.
The signed bytes are saved before transmission. An ambiguous send is reconciled
against the root account before retrying; the same bytes are reused until their
blockhash has expired at finalized commitment. Retries back off from 1 to 30
seconds. Overlapping worker ticks share one attempt.

A publication is recorded as confirmed only after a **finalized** read checks
the account owner, discriminator, root, leaf count, publication time and designated
authority. The root and global enrollment account are read in the same RPC bank
to determine whether the root is still in the last-four-root window. The worker
retries a confirmed bootstrap that is not yet visible in the finalized bank,
without confirming or submitting a root. A previously published root can be
reconciled without sending another transaction. Its
signature may be unavailable after a lost RPC response, but the account link
remains available.

On startup and every 30 seconds, the worker rechecks its latest confirmed root.
Evicted roots remain historical publications with `active: false`; their immutable
accounts are not republished. Current chain state must still be checked when a
proof is submitted. This increment does not connect the older observation
submission spike to the registry.

## Server configuration

First deploy the DEV-27 program and have its upgrade authority bootstrap
`initialize_enrollment_authority` with the publisher's public key. Fund that
publisher for transaction fees and root-account rent. The server only needs the
designated enrollment signer's keypair, stored outside the repository.

Build both packages from the repository root:

```sh
pnpm --filter @pathnod/solana build
pnpm --filter @pathnod/verifier build
```

Keep the App Attest settings from the
[DEV-26 runbook](dev26-observer-enrollment-service.md) and add:

```sh
export PATHNOD_ROOT_RPC_URL=https://api.devnet.solana.com
export PATHNOD_ROOT_PROGRAM_ID=REPLACE_WITH_DEPLOYED_PROGRAM_ID
export PATHNOD_ROOT_SIGNER=/private/tmp/pathnod-enrollment-signer.json
export PATHNOD_ROOT_BATCH_SIZE=16
export PATHNOD_ROOT_MAX_DELAY_MS=30000
node packages/verifier/dist/enrollment-http.js
```

All three RPC/program/signer settings are required together. If they are absent,
enrollment still works and `/root` reports `publication: {"enabled": false}`.
Batch size accepts 1–1,048,576 leaves; delay accepts 1–3,600,000 ms. The transport
allows localhost or HTTPS providers whose genesis hash matches devnet. It checks
that the program is executable and upgradeable, and that its enrollment authority
matches the signer before starting publication.

The database pins the cluster genesis, program ID and signer public key.
Changing them requires a planned database/deployment migration; restarting with
a different target fails. Run **one enrollment server writer per database**.
Back up the entire SQLite database, including publication state, using SQLite's
backup mechanism. Existing DEV-26 databases are migrated with leaf counts derived
from their enrollment journal; enrolled roots are preserved.

The runtime server continues to use the real `AppAttestGate`. No test gate is
selected through environment variables. Keep the database, its WAL files,
keypairs and RPC credentials private. Publication responses expose public roots,
counts and chain addresses without observer keys or attestation objects.

## Reading publication status

`GET /root` retains the local `root` and `revision` and adds `publication`:

| Field | Meaning |
| --- | --- |
| `state` | `empty`, `pending`, `retrying`, `checking`, `confirmed` or `inactive` |
| `pendingRevision` | Latest pending local revision, or the frozen attempt's revision |
| `lastError` | Stable error code; no signer material or raw RPC error |
| `confirmed.root`, `revision`, `leafCount` | Latest checked historical publication |
| `confirmed.active` | Last-four-root membership at the last successful check; `null` while unverified |
| `confirmed.lastCheckedAt`, `checkedAtSlot` | Check time in Unix milliseconds and RPC context slot |
| `confirmed.signature` | Transaction signature when available, otherwise `null` |
| `confirmed.address`, `explorer` | Root PDA and devnet account link; local explorer is `null` |

`checkedAtSlot` is the account-check slot, not the creation transaction's slot.
`confirmed` can describe an older root while new enrollments are pending. The
top-level local root is not automatically usable on-chain. Before proving, clients
must obtain a path for a published active root; DEV-26's path refresh returns the
latest local root, so clients must wait for its publication or refresh again.
This increment exposes the status needed for that integration.

## Verification

Unit tests cover batch thresholds, the oldest pending deadline, retries with
identical signed bytes, expiry, a lost RPC response followed by restart,
concurrent ticks, enrollments during publication, mismatched accounts, window
eviction, target changes and DEV-26 schema migration.

```sh
pnpm --filter @pathnod/verifier typecheck
pnpm --filter @pathnod/verifier test
```

The Anchor CI job deploys a disposable program, runs the DEV-27 registry harness
with a retained test publisher, then runs the actual HTTP enrollment server and
publication worker on the same validator. The synthetic harness uses a fake
App Attest gate only in test code. It checks a size-triggered batch of two leaves,
a delay-triggered third leaf, re-enrollment and restart without another publication.

To repeat that test on a fresh local deployment and fresh database:

```sh
pnpm --filter @pathnod/verifier roots:verify \
  --rpc http://127.0.0.1:18899 \
  --program REPLACE_WITH_DISPOSABLE_PROGRAM_ID \
  --wallet /private/tmp/pathnod-test-publisher.json \
  --bootstrap-wallet /private/tmp/pathnod-test-upgrade-authority.json \
  --database /private/tmp/pathnod-root-test.sqlite \
  --report /private/tmp/pathnod-root-test-report.json \
  --synthetic yes
```

For an existing verified enrollment database, use `--synthetic no` and the
official devnet RPC. That mode denies all new attestation/enrollment requests;
it publishes only the recorded tree. The harness refuses the shared spike program
and database/report paths inside the repository. The bootstrap wallet is optional
once the disposable program's authority and publisher funding are configured.

## Devnet validation — 2026-10-05

The worker published the existing physical iPhone's DEV-26 root from a private
database copy. No new synthetic enrollment was added to that tree.

- Disposable program: `DU4EkYX8We9fJfjPKkNdvKd98KvqjJpryQjxgEa8jJJ`.
- Root revision **1**, leaf count **1**:
  `0x304c122585b33e366799254b9ae53ccd86f7c40d68b307ad2b55212844107204`.
- [Root account](https://explorer.solana.com/address/2BFwnNGF8yZfTuupo2WucKEVB5LuEXc8AiEsymAk4ofA?cluster=devnet).
- [Publication transaction](https://explorer.solana.com/tx/bCj73hSycuoFeijKcU8i8kGYCpbpzcs3fiToRPQJkvS5Jb7MzFroB7RrLC6vdKaEww4QjtkRbZ9uRpGDidXcD6R?cluster=devnet).
- The global publication count advanced **0 → 1**. Restart preserved both
  account bytes and the count. A repeat run using finalized reads also preserved
  the count at **1** and reported the root active.

Only public evidence is recorded here. Databases, wallets, build output and
generated reports remain outside Git.
