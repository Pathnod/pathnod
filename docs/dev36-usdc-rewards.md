# DEV-36 — devnet USDC rewards and scoped withdrawals

Development assets only. No mainnet deployment, monetary-value token, reward
guarantee or anonymous withdrawal is implied.

## Payment contract

The deployment's enrollment authority initializes `PaymentSettings` and a fee
vault once. Use the legacy SPL devnet USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (six decimals). The local
integration harness creates a synthetic six-decimal mint instead.
The mint and treasury cannot be changed after initialization. The authorized
payment administrator can change fees using `updateFees` (0–10,000 basis points).
The default split is **80% observer / 20% Pathnod**. Fees are rounded down in
integer base units; the observer receives the remainder, conserving every unit.

After proof verification, a fresh observation is paid only when the epoch has
an unused paid slot and the protocol escrow covers the entire gross reward.
The paid observation atomically transfers net and fee amounts to separate SPL
vaults. Insufficient funding or exhausted quota accepts the observation unpaid,
without consuming a paid slot. Nullifier replay cannot credit twice.
Three paid slots are the demo default, configurable by the requester.
Eligibility now returns the **net** reward and limits open slots by escrow funding
in one finalized snapshot. Quotes are estimates, not reservations: concurrent
observations or fee/policy changes can change the eventual outcome.

Payout and token-vault seeds include protocol and canonical pseudonym. Accounting
tracks cumulative gross, fees, available, withdrawn and a claim nonce. Existing
protocol and commitment account layouts remain unchanged. Submit-observation
adds seven account metas and upgrades verifier metadata to ABI 2; ABI 1 is
rejected by the SDK. Existing deployments must upgrade the program and migrate
the small verifier metadata account to ABI 2 by rerunning the enrollment-authorized
`initializeObservationVerifier` before enabling the relay. It only writes the
compiled verification-key digest, ABI and input count, never caller-supplied keys.
Do not overwrite observation/epoch accounts.

## First withdrawal authorization

Only a successfully App-Attest- and Groth16-validated observation establishes
the server's pseudonym → enrolled attestation-key association. The first claim
requires a new App Attest assertion over the exact claim digest. Historic
receipts without that association are not silently backfilled; re-observe or
use an independently reviewed migration with original verified evidence.

The verifier signs SHA-256 of ASCII `Pathnod/claim/v0`, program, payout PDA,
mint, withdrawal key, destination, amount/nonce/expiry (little-endian u64,
expiry constrained to positive i64) and policy version (little-endian u32).
Expiry is at most five minutes. The claim verifies the immediate previous
Ed25519 precompile and requires the withdrawal key's transaction signature.
Only that key can claim after its first binding; the destination must be a
legacy token account of the same mint owned by that key. Exact nonce and
available-balance checks reject replays, wrong destinations and overspending.
Failed transfers roll back all accounting changes.

The requester can increase policy version and change verifier, gross reward and
quota via `updatePolicy`. Already earned balances are unaffected. Changes apply
to subsequent submissions immediately. A running verifier/relay pins its policy
target and must be restarted/migrated deliberately; stale authorizations fail
closed. Preserve enrollment keys, assertion counters, revocations, payout-owner
associations and durable jobs during any reviewed database migration. Never
discard the database or blindly rewrite target markers to change policy.
The payout-owner scope itself is stable across policy versions.

## Relay and HTTP

Observation submissions now require v0 transactions with a lookup table to fit
Solana's 1,232-byte packet limit. Set `PATHNOD_OBSERVATION_LOOKUP_TABLE` to an
active table containing the shared protocol, registry, payment and SPL accounts.
The integration harness creates one; use its reported address for that deployment.
The configured deployment must expose ABI 2 and the pinned verification key.
Persisted signed transaction retries retain the exact same bytes.

- `GET /payouts/{pseudonym}` reads finalized cumulative balances. `pending` means
  no on-chain payout account yet, not a validated observation or promised payment.
- `POST /payouts/quote`: pseudonym, withdrawal_key, destination.
- `POST /payouts/authorize`: the same fields plus key_id, assertion, expires_at.
  It returns a bound authorization, verifier signature and exact claim message.
  A consumed assertion counter is not reused if preparing the message fails;
  request a fresh assertion. No observer secret is transmitted.

## iOS testing

The **Devnet gains** screen requires verifier URL, deployment program ID and
32-byte protocol ID. It derives the existing observer pseudonym and creates an
Ed25519 withdrawal key stored in this iPhone's ThisDeviceOnly Keychain, scoped
by program/pseudonym (not server URL). Fund its public address with devnet SOL
and create a devnet USDC token account owned by it; paste that token-account
address. This manual setup is a v0 limitation; no external-wallet UX is included.
Loss of the withdrawal key or observer secret can make funds inaccessible.

The phone verifies the claim digest, signature, accounts, instruction data and
the exact Ed25519-plus-claim transaction before signing; it cannot sign arbitrary
server-supplied transfers. It saves approved bytes before broadcasting and
reuses them on retry. The saved withdrawal includes the exact signed wire,
transaction signature and `lastValidBlockHeight`. Recovery checks signature
history and finalized block height, then refreshes the finalized payout nonce.
An advanced nonce completes reconciliation; an unresolved signature retains the
saved transaction. A fresh withdrawal is allowed only after the old blockhash is
provably expired and the finalized nonce is unchanged, even if its authorization
still has time remaining. This requires a new quote/assertion and another explicit
withdrawal action; the app does not replace or broadcast a new transaction silently.
Authorization expiry alone never discards an ambiguous transaction. Older saved
files without blockhash-validity metadata are preserved conservatively rather than
automatically replaced; do not delete them to bypass reconciliation.
Refresh reads finalized accounting; submission alone is not displayed as a
finalized withdrawal.
Release builds require HTTPS; redirects are rejected.
Wallet ↔ pseudonym linkage is public in v0 and explicitly acknowledged in the UI.

## Verification

Run `cargo test --locked -p pathnod --lib`, SDK/verifier tests and typecheck,
`swift test --package-path apps/ios`, and the unsigned app build.
The Swift tests include an SDK-produced public claim message and tampering cases.
The verifier tests cover attested ownership, destination binding and assertion
counter replay. CI runs the real-proof local validator harness with payments:

```sh
pnpm --filter @pathnod/verifier observations:verify \
  --rpc http://127.0.0.1:18899 --program DISPOSABLE_PROGRAM \
  --wallet /tmp/wallet.json --database /tmp/policy.sqlite \
  --report /tmp/payment-report.json --payments yes
```

On devnet, use a disposable deployment and a funded test wallet holding at least
0.05 devnet USDC of the above mint. The harness tests a paid credit, insufficient
escrow fallback, wrong withdrawal authority, claim replay and policy update while
preserving earned balances, alongside the DEV-35 proof/replay/root tests.
Its App Attest enrollment is explicitly synthetic; it does **not** substitute
for a real iPhone App Attest test. `@kazai777` should run the complete physical
phone → verifier → credited payout → withdrawal path, including interrupted
network/restart, and confirm the actual mint, destination and balances.

### Local verification on 2026-10-07

- 14 Rust tests and the SBF v3 build passed.
- 14 SDK tests, 70 verifier tests (two hardware/fixture-dependent tests skipped),
  TypeScript typecheck and all Swift package tests passed.
- The unsigned Simulator build passed; seven app regression tests passed, with
  the physical-observation test explicitly skipped.
- A disposable local deployment executed the two real fixture proofs: one paid
  credit and one accepted unpaid observation after escrow depletion. The signed
  submission was 1,133 bytes and consumed 192,156 CU on the first observation.
- A 0.05 gross reward produced 0.01 fees and 0.04 available; withdrawal finalized
  in 15,254 CU. Wrong-owner and repeated withdrawals were rejected. Updating the
  policy preserved accounting. Final SPL balances conserved the entire reward.
- Lost-RPC-response restart, external-submission reconciliation, duplicate
  nullifiers and inactive roots were also checked. The first run expired during
  setup; the fresh second run completed after enabling identical-byte RPC retries
  for the harness's preparation transactions.

### Devnet verification on 2026-10-07

The disposable program `DC6eAz9YXY1aavsuHEk2tjkRjC6HS6AmGE2Z9u1nCXrW`
was deployed using the funded test wallet. Circle test USDC was confirmed on
the required mint. The escrow was funded with 0.05 USDC once, not again on retry.
The initial RPC deployment reached its retry limit; resuming the same buffer via
TPU completed deployment. The full harness then hit a public RPC connection-rate
limit after account preparation, before registering observations.

A scoped recovery on the same funded deployment rotated the test verifier through
the requester's authorized `updatePolicy`, then completed direct SDK transaction
tests with the two checked-in real Groth16 proofs and synthetic verifier
authorization. The production finalized payout reader independently confirmed
gross 0.050000, fees 0.010000, available 0.000000, withdrawn 0.040000 and nonce 1.

- [Paid observation](https://explorer.solana.com/tx/63Ra2rzhdKC3oSuPAfa9PGVuV56KhzangnYDY49w9sbamBg6eWUgQPa9XdGgX5wW4BEjr7Bi2iX6sw7muhKS5JYs?cluster=devnet): 1,133 bytes, 192,163 CU.
- [Second observation, accepted unpaid](https://explorer.solana.com/tx/3H9J244GawdZ4MJKZGcoXLfqsjaERafcvq63UXzjiBpj6enGbXApJEjbMDecWW8BDjSpr6XZiMZLaAAyiq4KB1m2?cluster=devnet): escrow exhausted; paid slot count remained 1.
- [Finalized withdrawal](https://explorer.solana.com/tx/3khTQVmkcnJtNsrpne2BAN7S4gqr2AvVhxznjXuQx2qkd6gA4JyVYHvEGcqTEqzsyAWHduZJGTiHHtdreq4ds8W4?cluster=devnet): 0.04 USDC, 15,261 CU.
- [Policy update](https://explorer.solana.com/tx/5prcfT5jLv9XKjokWFK5M8mhQjof4M2WZ3ht1rGo8UvKSqwGpD5XjxZoyM4z7F6LxgwyFgoNFYQdNVnTz1fSCcE?cluster=devnet): preserved earned/withdrawn accounting.

Duplicate observations, missing first-binding authorization, wrong withdrawal
owner, overspending and repeated claims were rejected in devnet simulation.
Actual SPL balances conserved 0.05 gross = 0.01 fees + 0.04 withdrawn.
The harness now shares request pacing across its source and transport readers,
with bounded backoff on HTTP 429, rather than pacing only its initial connection.

These devnet tests cover on-chain payment instructions, **not** a complete real
iPhone App Attest → HTTP verifier → relay → withdrawal session. That hardware
validation remains outstanding with `@kazai777`. No mainnet assets or existing
project deployment were modified.
