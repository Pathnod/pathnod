# DEV-15 — Solana Groth16 verification spike

This spike builds on DEV-13's depth-20 observation circuit, without changing
its seven public inputs or setup. It is **development-only**, not a production
ceremony, registry, BLE attestation check, or observation acceptance API.
DEV-16 must select a trusted key, bind the transcript, validate roots/epochs,
and enforce nullifier uniqueness before accepting observations.

## Wire contract

`groth16-solana = 0.2.0` is pinned. All scalars and point coordinates use
32-byte **big-endian** encoding. Scalars must be strictly smaller than BN254
Fr; coordinates use the different BN254 Fq modulus. No modular reduction of
public inputs is allowed.

- Inputs, in order: `root`, `protocol_id_f`, `device_id_f`, `epoch`,
  `nullifier`, `pseudonym`, `class_pub`.
- G1: `x || y`. The client **negates A's y over Fq** exactly once.
- G2: `x.c1 || x.c0 || y.c1 || y.c0` (snarkjs uses c0,c1).
- Verification key: alpha G1, beta/gamma/delta G2, **eight** IC G1 points.
  Fixed Borsh arrays, 960 bytes, no length prefix.
- Verification instruction arguments: negated A (64), B (128), C (64),
  inputs (224): 480 bytes after Anchor's 8-byte instruction discriminator.

Each wallet initializes an immutable `dev15-vk` PDA containing its key. There
is no key-update instruction. This intentionally allows caller-selected
**test** keys and must not be used to confer protocol trust. Initialization
just fits the 1,232-byte transaction limit; do not add budget instructions to
it. Verification uses a 400,000-CU budget and must measure below 300,000 CU.

## How to test locally

Use the versions in the toolchain ADR (Node 24.21.0, pnpm 11.27.1,
Circom 2.2.3, Anchor 1.2.0, Solana 4.2.2, platform-tools v1.57).
From the repository root:

```sh
pnpm install --frozen-lockfile
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings -A unexpected-cfgs
anchor build --tools-version v1.57 --arch v3 --ignore-keys
pnpm --filter @pathnod/circuits test
pnpm --filter @pathnod/circuits dev13:prove
```

Keep the printed artifact directory outside Git. DEV-13 generates a fresh
local development setup and verifies the proof with snarkjs. In a separate
terminal, start an isolated validator (no global Solana config changes):

```sh
task_ledger=$(mktemp -d /tmp/pathnod-dev15-ledger.XXXXXX)
solana-test-validator --ledger "$task_ledger" \
  --bpf-program 5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd target/deploy/pathnod.so \
  --rpc-port 18899 --faucet-port 18902 \
  --dynamic-port-range 19000-19040 --bind-address 127.0.0.1
```

Create a disposable test wallet, fund it locally, then run the harness:

```sh
task_wallet_dir=$(mktemp -d /tmp/pathnod-dev15-wallet.XXXXXX)
solana-keygen new --silent --no-bip39-passphrase --outfile "$task_wallet_dir/wallet.json"
solana airdrop 10 --url http://127.0.0.1:18899 --keypair "$task_wallet_dir/wallet.json"
pnpm --filter @pathnod/circuits dev15:verify \
  --artifacts /tmp/REPLACE_WITH_DEV13_DIRECTORY \
  --rpc http://127.0.0.1:18899 --wallet "$task_wallet_dir/wallet.json" \
  --program 5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd
```

The harness checks snarkjs verification first, exports the converted binary
key/proof, initializes or validates the immutable config, rejects an altered
root and corrupted C specifically with verifier error 6000, then confirms the
valid transaction. `dev15-report.json` records its signature, program ID,
key hash, verification-only CU, transaction-total CU, and budget. Verification
CU is the difference between two runtime `sol_log_compute_units_` readings
bracketing verifier construction, input preparation and pairing. It includes
the end meter's small syscall cost, but excludes Anchor account deserialization.
The total comes from
the confirmed transaction metadata. Proofs, reports, keys and wallets stay
outside the repo. Stop the validator with Ctrl+C after testing.

## Devnet

Use an explicitly selected **devnet-only** wallet and a fresh program keypair.
Do not overwrite the shared program, reuse production funds, change the global
RPC configuration, or commit private keys. Build/deploy a disposable checkout
whose `declare_id!` matches that fresh program keypair, using the same pinned
build command. Deploy with explicit flags:

```sh
solana program deploy --url https://api.devnet.solana.com \
  --keypair /tmp/DEVNET_WALLET.json --program-id /tmp/DEVNET_PROGRAM.json \
  /tmp/DISPOSABLE_CHECKOUT/target/deploy/pathnod.so
pnpm --filter @pathnod/circuits dev15:verify \
  --artifacts /tmp/REPLACE_WITH_DEV13_DIRECTORY \
  --rpc https://api.devnet.solana.com --wallet /tmp/DEVNET_WALLET.json \
  --program REPLACE_WITH_FRESH_PROGRAM_ID
```

The harness refuses non-local/non-devnet RPCs and checks the devnet genesis
hash. Attach the devnet report's public transaction signature and CU values
to the PR; **a local report alone does not satisfy DEV-15's devnet criterion**.
A public devnet test of DEV-13's disposable key is permitted only for this
spike. Never deploy it to mainnet or use it to accept real observations.

## Validation recorded during implementation

On 2026-10-01, with the pinned toolchain and a freshly generated DEV-13 setup:

- Local SBF transaction confirmed: valid proof accepted, altered root and
  corrupted C rejected with custom error 6000.
- Initial local measurement: **113,338 CU**; transaction total: **117,743 CU**,
  with a **400,000-CU** budget.
- Circuit: **5,891 constraints**, unchanged seven-input contract.
- The final binary was also validated on **devnet**: valid proof confirmed,
  altered root and corrupted C rejected with verifier error 6000.
- Final devnet verification cost: **113,334 CU**, including the end meter's
  syscall cost; transaction total: **117,251 CU**; budget: **400,000 CU**.
- Disposable devnet program: `5NYa9RTETT2Vop7Qt42TQKSSFCZ2HeDH4MykdibNKgj4`.
  This is separate from the shared program ID in the repository.
- [Confirmed devnet verification transaction](https://explorer.solana.com/tx/4t5ZyUsy1etjGyRoixVft3WV8j1Z57BRZBk3iwfGPe2JJvi9SpJTS7ptshjDj1yvytQbe8yyQx1DgZJnKQZGuxVb?cluster=devnet).
- Verification-key binary SHA-256:
  `26e618d24ec207c7cf55dbbe3a4016cd7cc37e48a94d860a77fde00593ee1ee0`.
- The direct `sol_remaining_compute_units` call failed on devnet before proof
  verification (`unsupported BPF instruction`), despite working locally.
  Runtime meter logging resolved this instrumentation issue without changing
  the pinned toolchain or weakening the verifier/negative-test assertions.
- JavaScript audit: no moderate/high/critical advisory; the existing
  low-severity `elliptic` advisory remains. A scoped `@solana/web3.js>jayson`
  override selects `jayson` 5.0.0, removing the vulnerable `stream-json` and
  `uuid` dependencies. A mocked RPC regression test covers balance,
  blockhash, transaction submission, and signature-status calls without
  sending a transaction to a network. The CI severity threshold is unchanged.

Reports/artifacts remain outside Git. The final devnet report supplies the
public signature and measured CU required by DEV-15; the disposable setup
still must not be used for production observations.
