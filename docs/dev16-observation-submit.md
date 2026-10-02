# DEV-16 — observation submission spike

`submit_observation` verifies the seven-input DEV-13 Groth16 proof with an
immutable DEV-15 test key, then records the nullifier at the program PDA
`[b"obs", nullifier]`. The PDA stores all seven public inputs, the key-config
address, submitter, and acceptance slot. A second submission of the same
nullifier fails with `E_NULLIFIER` (custom error 6001), even with another
payer. A failed proof or changed public input does not create a commitment.

This is a development-only integration. The key is selected by its creator;
neither the circuit's transcript nor a registry, active root, epoch, device,
or attestation is trusted by this instruction. Do not use it for real
observations or rewards. Those trust checks belong to later protocol work.

## Local test

Use the pinned versions in [ADR 0001](decisions/0001-toolchain-and-monorepo.md),
especially Agave 4.2.2 for the SBF v3 binary. From the repository root:

```sh
pnpm install --frozen-lockfile
cargo build-sbf --manifest-path programs/pathnod/Cargo.toml --tools-version v1.57 --arch v3
pnpm --filter @pathnod/circuits dev13:prove
```

The last command prints a fresh artifact directory outside Git. In another
terminal, start a local validator:

```sh
task_ledger=$(mktemp -d /tmp/pathnod-dev16-ledger.XXXXXX)
solana-test-validator --ledger "$task_ledger" \
  --bpf-program 5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd target/deploy/pathnod.so \
  --rpc-port 18899 --faucet-port 18902 \
  --dynamic-port-range 19000-19040 --bind-address 127.0.0.1
```

In the first terminal, create a disposable wallet and run the harness:

```sh
task_wallet_dir=$(mktemp -d /tmp/pathnod-dev16-wallet.XXXXXX)
solana-keygen new --silent --no-bip39-passphrase --outfile "$task_wallet_dir/wallet.json"
solana airdrop 10 --url http://127.0.0.1:18899 --keypair "$task_wallet_dir/wallet.json"
pnpm --filter @pathnod/circuits dev16:submit \
  --artifacts /tmp/REPLACE_WITH_DEV13_DIRECTORY \
  --rpc http://127.0.0.1:18899 --wallet "$task_wallet_dir/wallet.json" \
  --program 5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd
```

The harness confirms each transaction, checks the resulting account bytes,
funds a second disposable payer, and records signatures, packet size and CU
in `dev16-report.json` inside the artifact directory. It requires a fresh
program for the synthetic nullifier and refuses RPCs outside localhost and
the official devnet endpoint.

## Devnet

Use a fresh program ID, a disposable devnet wallet, and an isolated checkout
whose `declare_id!` matches that program ID. Do not overwrite the shared
program, commit keypairs, or change global Solana configuration. Build the
isolated checkout with the command above, then deploy with explicit flags:

```sh
solana program deploy --url https://api.devnet.solana.com \
  --keypair /tmp/DEVNET_WALLET.json --program-id /tmp/DEVNET_PROGRAM.json \
  /tmp/DISPOSABLE_CHECKOUT/target/deploy/pathnod.so
pnpm --filter @pathnod/circuits dev16:submit \
  --artifacts /tmp/REPLACE_WITH_DEV13_DIRECTORY \
  --rpc https://api.devnet.solana.com --wallet /tmp/DEVNET_WALLET.json \
  --program REPLACE_WITH_FRESH_PROGRAM_ID
```

## Local validation on 2026-10-02

Agave 4.2.2 accepted the valid observation and rejected a corrupted proof,
changed nullifier input, and replay from another payer. Both invalid-proof
transactions left their target PDAs absent. The replay returned
`E_NULLIFIER` (6001) without changing the commitment. The valid transaction
used **126,861 CU** with a **400,000-CU** budget; the Groth16 verifier used
**113,334 CU**, and the signed transaction was **798 bytes**, below Solana's
1,232-byte packet limit. Generated proofs, reports, and wallets remain outside
Git.

## Devnet validation on 2026-10-02

The same synthetic proof was submitted to the disposable devnet program
`9eniETGGSrez7YaAPPWpH5oULKPVC24z3NKJBcDZ4pKL`. The
[valid submission](https://explorer.solana.com/tx/67Da1Ys6wuH1oV4BpBaL2UWiButdQnNtriMt8mkjtpJSn2QN64nMDYxEz2eHW1aSTvb2e7suLg5TkQWrTSH8sSPA?cluster=devnet)
created commitment PDA `GFYXtajt4Ss968kfYDsPfaFXESHZTT1dQYBFmmhpVy5W`.
The
[replay from a second payer](https://explorer.solana.com/tx/4taJ8ospwCMhYJPZKuXnNUiH3BFvPSpzNRBSH9CCrftHhXX4LRHV91vfz3Fb5UYGS63meLYncEgM1AHveMKgKrct?cluster=devnet)
failed with `E_NULLIFIER` (6001) and left the commitment unchanged. A
[corrupted proof](https://explorer.solana.com/tx/4tCRx2UNNRgwNPxKykojbZyVeEdjWp83ME8qyCAongnHvqu11LAs6ZW5XAbULLAaCGYcZKzEGvyUhhfLK4NR5zzW?cluster=devnet)
and a
[changed nullifier input](https://explorer.solana.com/tx/5D5GwYfXFBPYEaArc46wvqWu7gsW5iR8ybT6EsojboyKi3YSJfrkvfcViKWG7a9p4GutwArNngY1fBThPAPTbnSa?cluster=devnet)
both failed with verifier error 6000 and left their target PDAs absent.

The valid devnet transaction used **132,861 CU**, including **113,334 CU**
for Groth16 verification, with a **400,000-CU** budget. Its signed packet was
**798 bytes**. The disposable verification key's SHA-256 is
`958efe006ebab61251b11aaf003c100e5a95f0f51525f7c55d4bd7f07c18e683`.
