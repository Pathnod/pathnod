# DEV-34 — verifier authorization and durable relay

## Scope and integration boundary

The DEV-33 policy engine can now sign and enqueue **fresh accepted** observations
atomically with its receipt and counter updates. The relayer library persists
signed Solana transactions before sending, reconciles ambiguous outcomes, and
exposes queued/submitted/confirmed/failed status separately from policy validation.

**Production submission is not wired yet.** DEV-35 must implement
`ObservationSubmissionAdapter` using the final instruction/account ABI and check
the resulting observation commitment in `confirm`. The DEV-16 caller-selected-VK
spike must never be substituted for that adapter. There is no production relay
CLI, automatic worker timer, public enqueue endpoint, or reward-payment claim.
The HTTP server queues accepted observations when signing is enabled; it does
not start broadcasting. Its existing `validated` receipt remains a policy receipt.

## Frozen authorization contract

Sign the 32-byte SHA-256 digest of this concatenation using Ed25519:

```
ASCII("Pathnod/verified/v0")
|| transcript_hash[32] || nullifier[32] || pseudonym[32]
|| class:u8 || policy_version:u32 little-endian
```

Hashes/scalars are their raw 32 bytes, not UTF-8 hex. Nullifier and pseudonym must
be canonical BN254 Fr values. Class is 1–3; policy version is 1–u32::MAX.
Policy version uses Borsh/ProtocolConfig little-endian encoding. A shared public
fixture locks bytes, digest, public key and signature across TypeScript and Rust.
Its deterministic test key is **not a production verifier**.

The 480-byte proof uses the existing DEV-15 ABI: negated A, G2 c1/c0 limbs, C,
then seven big-endian Fr inputs. The queue checks that epoch, nullifier, pseudonym
and class agree with those inputs. The Solana transport inserts a self-contained
Ed25519 precompile immediately before the DEV-35 consumer instruction; DEV-35
must inspect and bind that instruction, not merely accept arbitrary prior Ed25519
verification.

## Signing and storage

Set `PATHNOD_OBSERVATION_VERIFIER_SIGNER` to the path of a local Solana-format
64-byte keypair JSON file, regular file, at most 4096 bytes, permissions 0600.
Never put a seed/private key into environment values, source, logs or the queue.
The DEV-33 observation configuration is required. The current onchain verifier
must match the signer; the policy version comes from the trusted config snapshot.
Disable the option to retain unsigned DEV-33-only behavior.

Signing occurs only after all policy checks and inside the final SQLite
transaction. Failed signing/enqueue/capacity checks roll back receipt and both
counter updates. Identical retries reuse the receipt/job. Receipts accepted before
enabling relay are **not** backfilled or reauthorized. Queue capacity defaults to
the policy ledger capacity (100,000); programmatic configuration can lower it.
Finalized rows count toward capacity: archival/retention is an operator decision,
not silent deletion of replay protection.

The minimized payload contains commitments, public inputs/proof and verifier
authorization, not full transcript, raw evidence, precise location, App Attest
assertion, observer key ID or private keys. SQLite still contains sensitive
operational metadata; restrict file/directory access and backups. Treat its data
as trusted. This is not encrypted storage or a multi-host queue.

## Worker lifecycle and recovery

The caller constructs the DEV-35 adapter, opens `SolanaObservationRelayTransport`
with a **separate relayer fee payer**, and constructs `ObservationRelayer` with
the policy database and pinned policy target. Call `tick()` periodically and
`close()` during shutdown. Each tick processes up to 16 due rows. Concurrent ticks
coalesce. One live worker owns a database using PID/token ownership; only a dead
local PID can be reclaimed. PID reuse/permission errors fail closed. Do not share
this SQLite file between hosts; use one local host and recover manually if needed.

Cluster genesis, program, protocol, verifier, payer and adapter contract are pinned.
The transport checks executable program ownership and finalized registry state,
current verifier/policy, accepted enrollment root and unused nullifier before send.
HTTPS RPC or loopback HTTP only; redirects/URL credentials are rejected, requests
time out after 10 seconds. The transaction is limited to 1232 bytes.

The worker persists exact signed bytes/signature/blockhash expiry **before send**.
Lost responses and restarts inspect transaction history first. Missing transactions
are resent with identical bytes while valid. Replacement requires observed expiry
and a second missing-history check; pending/uncertain RPC outcomes never trigger
replacement. There are at most eight generations, with retry backoff capped at
one hour for failures. Finalized transaction errors are terminal. Success requires
both finalized execution and adapter confirmation of the actual commitment.
`on_chain` is true only for confirmed rows; `paid` stays false. Changing a pinned
target/key requires explicit operator migration, not automatic resigning.

## Validation and remaining acceptance checks

Run verifier typecheck/build/tests and `cargo test --locked -p pathnod --lib`.
Tests cover the shared digest, tampering, policy rejection without queue writes,
atomic rollback, capacity, historical retries, restart, ambiguous RPC responses,
identical-byte retries, expiry replacement and pinned-target changes.

Optional real devnet **precompile-only probe**:

```
PATHNOD_DEVNET_FEE_PAYER=/absolute/path/to/test-wallet.json \
  node packages/verifier/scripts/dev34-precompile.ts
```

This spends one test transaction fee (guarded at 100,000 lamports), simulates a
tampered signature, sends the valid public fixture, and confirms finalized success.
It does **not** deploy Pathnod, register an observation, verify a Groth16 proof
onchain or pay rewards. The wallet must contain devnet SOL, never mainnet funds.

DEV-35 end-to-end acceptance remains open: actual submission/account ABI,
onchain authorization binding, real commitment/nullifier confirmation, executable
worker integration and tests for concurrent/external submissions and key/root
changes on a validator/devnet. A signature probe cannot validate these properties.

### Recorded development validation — 2026-10-07

- Verifier typecheck/build passed with Node 24.15.0 and pnpm 11.27.1. The repository
  pins Node 24.21.0; that exact patch version was not available for this local run.
- Verifier suite: 59 passed, 2 optional evidence/integration tests skipped, 0 failed.
- Rust: 6 library tests passed; `cargo fmt --all -- --check` passed. Existing Anchor
  macro `unexpected_cfgs` warnings remain.
- Real devnet precompile probe finalized successfully; tampered signature rejected
  in simulation. Fee: 10,000 lamports (0.00001 SOL). No observation or payout.
- Public transaction:
  [52cpGxU…vMT4rG](https://explorer.solana.com/tx/52cpGxUzu6oZuUaqjnEESjYspBcnoqLFvjfHvwYBHbAL6452TvoP4fbyePWdBE6EnJi7rVzRkyMc5XF2B1vMT4rG?cluster=devnet).

References: [Solana precompiles](https://solana.com/docs/core/programs/precompiles),
[transaction confirmation](https://solana.com/developers/cookbook/transactions/confirmation).
