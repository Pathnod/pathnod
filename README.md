# Pathnod

Privacy-preserving proof of presence for physical infrastructure, built on Solana.

This repository currently contains the toolchain baseline and the monorepo
skeleton only (DEV-01/DEV-02). The single Solana program exists to prove the
pinned toolchain builds; no protocol feature is implemented yet.

## Layout

```text
apps/ios/            iOS app                    placeholder
apps/dashboard/      operator dashboard         placeholder, npm workspace
tools/device-sim/    beacon simulator           placeholder
firmware/esp32/      ESP32 beacon firmware      placeholder
packages/circuits/   ZK circuits and proving    placeholder, npm workspace
packages/verifier/   off-chain verifier         placeholder, npm workspace
programs/pathnod/    Solana program             minimal, buildable
docs/                decisions and notes
```

Each placeholder directory has a README naming its future stack and what is
deliberately not implemented yet.

## Pinned versions

Every version below is exact and frozen for the hackathon. Do not substitute
floating channels (`stable`, `latest`, caret ranges), AVM nightly mode, Agave
beta/RC builds or Node 26. Changing any pin requires a new ADR.

| Component | Version | Pinned in |
|---|---|---|
| Rust | `1.95.0` | `rust-toolchain.toml` |
| Agave / Solana CLI | `4.2.2` | `Anchor.toml` |
| Anchor CLI and crates | `1.2.0` | `.anchorversion`, `Anchor.toml`, `programs/pathnod/Cargo.toml` |
| SBF platform-tools | `v1.57` | build flags below (also the Anchor 1.2.0 default) |
| SBF architecture | `v3` | build flags below (also the Anchor 1.2.0 default) |
| Node.js | `24.21.0` | `.nvmrc`, `.node-version` |
| npm | `11.19.0` | `package.json` → `packageManager` |

The rationale is in
[`docs/decisions/0001-toolchain-and-monorepo.md`](docs/decisions/0001-toolchain-and-monorepo.md),
which is authoritative.

## Install

Linux prerequisites: `curl`, a C toolchain, `pkg-config`, OpenSSL development
headers, Git. macOS: Xcode command-line tools.

```sh
# Rust host toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup toolchain install 1.95.0 --profile minimal --component rustfmt,clippy

# Agave/Solana CLI, exact stable release
sh -c "$(curl -sSfL https://release.anza.xyz/v4.2.2/install)"

# AVM from the exact Anchor release; avoid the floating master installer
cargo +1.95.0 install --git https://github.com/otter-sec/anchor \
  --tag v1.2.0 avm --locked --force
avm nightly --disable || true
avm install 1.2.0
avm use 1.2.0

# Node and npm
nvm install 24.21.0
nvm use 24.21.0
npm install --global npm@11.19.0
```

## Verify versions

Run from the repository root. A mismatch is a failed check; do not continue with
a newer version.

```sh
rustc --version     # rustc 1.95.0 (...)
cargo --version     # cargo 1.95.0 (...)
solana --version    # solana-cli 4.2.2 (... client:Agave)
avm list            # 1.2.0 installed and selected
anchor --version    # anchor-cli 1.2.0
node --version      # v24.21.0
npm --version       # 11.19.0
```

## Build

```sh
anchor build
```

This must succeed and produce the program `.so` and the IDL. Then run the
explicit equivalent to prove the frozen compiler settings:

```sh
anchor build --tools-version v1.57 --arch v3
```

### Diagnostic fallback

If `anchor build` fails in the Anchor wrapper or IDL step, keep its full log and
try only the lower-level program build:

```sh
cargo build-sbf \
  --manifest-path programs/pathnod/Cargo.toml \
  --tools-version v1.57 \
  --arch v3
```

This is a diagnostic, not an alternative definition of done. If `cargo
build-sbf` succeeds while `anchor build` fails, the build is still broken:
report the Anchor/IDL failure. Reproduce from a clean checkout and record the
failure before touching any version.

## Repository checks

```sh
cargo +1.95.0 fmt --all -- --check
cargo +1.95.0 check --workspace --locked
npm ci
npm run build --workspaces --if-present
npm test --workspaces --if-present
git diff --check
git status --short
```

## Program ID

`programs/pathnod/src/lib.rs` and `Anchor.toml` declare the same program ID. The
deploy keypair is **not** committed, so anyone building here owns a different
one. Before a first deploy, generate and sync it locally:

```sh
anchor keys sync
```

That rewrites `declare_id!` and `Anchor.toml` from
`target/deploy/pathnod-keypair.json`, which stays git-ignored.

## Safety rules for this repository

- The provider is **Devnet only**. No mainnet configuration belongs here.
- Never commit keypairs, seed phrases, `.env` files, RPC tokens, `.zkey`/`.ptau`
  artifacts, `target/`, `node_modules/` or compiled binaries.
- The wallet path in `Anchor.toml` is a local convention; the file itself is
  yours and is never part of the repository.

## License

Apache-2.0. See [LICENSE](LICENSE).
