# DEV-16 — observation submission spike

`submit_observation_spike` verifies the seven-input DEV-13 Groth16 proof with an
immutable DEV-15 test key, then records the nullifier at the program PDA
`[b"dev16-obs", nullifier]`. The PDA stores all seven public inputs, the key-config
address, submitter, and acceptance slot. A second submission of the same
nullifier fails with `E_NULLIFIER` (custom error 6001), even with another
payer. A failed proof or changed public input does not create a commitment.
The instruction carries the 32-byte nullifier separately so Anchor can
describe its PDA seed in the IDL; the program requires it to equal the fifth
public input before verifying or recording the observation.

This is a development-only integration. The key is selected by its creator;
neither the circuit's transcript nor a registry, active root, epoch, device,
or attestation is trusted by this instruction. Do not use it for real
observations or rewards. Those trust checks belong to later protocol work.

DEV-35 reserves `submit_observation` and `[b"obs", nullifier]` for trusted
observations. The spike was renamed and isolated when DEV-35 was introduced;
the original DEV-16 deployment used the historical names. Use a fresh deployment
for the current harness and production ABI.

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

## Local validation on 2026-10-03

Agave 4.2.2 accepted the valid observation and rejected a corrupted proof,
changed nullifier input, a nullifier argument that disagreed with that input,
and replay from another payer. All three invalid submissions left their
target PDAs absent. The replay returned
`E_NULLIFIER` (6001) without changing the commitment. The valid transaction
used **126,628 CU** with a **400,000-CU** budget; the Groth16 verifier used
**113,334 CU**, and the signed transaction was **830 bytes**, below Solana's
1,232-byte packet limit. Generated proofs, reports, and wallets remain outside
Git.

## Devnet validation on 2026-10-03

The same synthetic proof was submitted to the disposable devnet program
`AGimQYqrUsNNg37CgrgooKf7utGQdHwj1GDtTMCVKBeK`. The
[valid submission](https://explorer.solana.com/tx/4MJAXiEApwPeVJq6CzFpytiLMVKJCYPBxVBjBrnEtvCHjSuirAEGGtkz2faATUYj1pD2GiFEw9UceeBuNNDrc127?cluster=devnet)
created commitment PDA `DjvMNs2uvBvjjz1qS3vWWXZ8bkNrqprQS14H1oTKKQy3`.
The
[replay from a second payer](https://explorer.solana.com/tx/2D46J1Xhxt7C8CaUnkUiUZAE68GbrhD8DBm7Kcm6yoQZ7e4SZd1fERsJKKFCqqng7xwRjCEvmxC5n9RYD2pMJpbq?cluster=devnet)
failed with `E_NULLIFIER` (6001) and left the commitment unchanged. A
[corrupted proof](https://explorer.solana.com/tx/4EHD3mVGyNUNF85DnxsiR4tAdkyvmybgn4v73sDwzDhBEFLA7JUbHdctg13UYTdd9btArwW5eRB8z1pUrqonCecT?cluster=devnet)
and a
[changed nullifier input](https://explorer.solana.com/tx/5Cz1ryuWZK1fvAZZbknBL3H4fV6WgTG8dJsSHi78nAk7wKiSoM8ur4Sji6bwT1FVcWgZEcsQFLB82ye5nFAUYH3s?cluster=devnet)
failed with verifier error 6000. A
[mismatched nullifier argument](https://explorer.solana.com/tx/5g6Y37qQ316upEEeFT1UM2HzXr2cM11B4P7MyLxajKjxTb8EFSv3TdnPDTpks3jaap1xePWc7bmGLzHXWpCCv5nh?cluster=devnet)
also failed with error 6000. All three target PDAs remained absent.

The valid devnet transaction used **125,128 CU**, including **113,334 CU**
for Groth16 verification, with a **400,000-CU** budget. Its signed packet was
**830 bytes**. The disposable verification key's SHA-256 is
`958efe006ebab61251b11aaf003c100e5a95f0f51525f7c55d4bd7f07c18e683`.
