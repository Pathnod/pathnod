# ADR 0001 — Toolchain and monorepo baseline

- Status: accepted for DEV-01/DEV-02
- Date: 2026-09-21
- Scope: local hackathon baseline only; do not upgrade any pinned version before the code freeze unless a reproducible blocker is recorded.

## Decision

Use the following exact versions:

| Component | Pin | Repository/config pin |
|---|---:|---|
| Rust host toolchain | `1.95.0` | `rust-toolchain.toml` |
| Agave / Solana CLI | `4.2.2` | `Anchor.toml` → `[toolchain].solana_version` |
| Anchor CLI and crates | `1.2.0` | `.anchorversion`, `Anchor.toml`, exact Cargo dependencies |
| SBF platform-tools | `v1.57` | explicit verification/fallback flags; also Anchor 1.2.0 default |
| SBF architecture | `v3` | explicit verification/fallback flags; also Anchor 1.2.0 default |
| Node.js | `24.21.0` LTS | `.nvmrc` and `.node-version` |
| npm | `11.19.0` | root `package.json` → `packageManager`; commit `package-lock.json` |
| Future Groth16 verifier crate | `groth16-solana = "=0.2.0"` | add only in DEV-15, with the compatibility spike below |

Do not use floating `stable`, `latest`, caret ranges for the items above, AVM nightly mode, Agave beta/RC releases, or Node 26 Current during the hackathon.

### Why this matrix

- Anchor 1.2.0 is the latest stable Anchor release as of this decision. It adds explicit platform-tools and SBPF architecture selection. Its current CLI documentation states that `anchor build` defaults to platform-tools `v1.57` and `--arch v3`.
- Anchor 1.1 established Rust `1.89` as the `anchor-lang` MSRV. Rust `1.95.0` satisfies that floor and matches the Rust version used by platform-tools `v1.57`, reducing host/SBF lockfile and edition drift.
- Agave `4.2.2` is the current Devnet version floor on 2026-09-21. Anchor's `v3` output requires Agave 4.0 or newer for compatible local test tooling.
- Node 24 is LTS; `24.21.0` ships npm `11.19.0`. The root npm metadata pins that toolchain without inventing packages for components that are not implemented yet. Future JavaScript packages can join npm workspaces when they contain real code.
- `groth16-solana` 0.2.0 is the current published crate and uses Solana BN254 syscalls. Its repository documents compatibility work around older SBF compilers, but there is no upstream statement proving the exact combination Anchor 1.2.0 + Agave 4.2.2 + platform-tools v1.57. Therefore the version is frozen, while actual integration remains an explicit DEV-15 spike, not an invitation to change the global toolchain.

Anchor's Rust SDK dependencies are in the Solana 3.x crate family while Agave CLI 4.2.2 is validator/CLI tooling. These version numbers do not need to match. Do not add a direct `solana-program` dependency to the Anchor program unless a later task proves it is required; use Anchor 1.2's split Solana crates or re-exports to avoid duplicate-type conflicts.

### Matrix validation performed for this ADR

The selected matrix was exercised on 2026-09-21 in a disposable minimal Anchor workspace using the exact upstream Linux release binaries and the official `rust:1.95.0-trixie` container:

```text
rustc 1.95.0 (59807616e 2026-04-14)
cargo 1.95.0 (f2d3ce0bd 2026-03-21)
solana-cli 4.2.2 (src:c9c6f328; feat:21b0d33a, client:Agave)
anchor-cli 1.2.0
```

Both required paths completed with exit code 0 against `anchor-lang = "=1.2.0"`:

```sh
anchor build
cargo build-sbf --manifest-path programs/pathnod/Cargo.toml \
  --tools-version v1.57 --arch v3
```

`anchor build --tools-version v1.57 --arch v3` also completed with exit code 0. The probe generated the SBF release artifact, IDL build/test artifacts and a Cargo lockfile. It emitted the known Anchor macro `unexpected cfg` warnings (`custom-heap`, `custom-panic`, `anchor-debug`) and a synthetic program-ID mismatch warning because the disposable source deliberately used the system-program placeholder instead of syncing its generated keypair; neither warning blocked the build. The disposable workspace and generated keys/artifacts were removed after validation.

## Reproducible installation

Prerequisites on Linux: `curl`, a C toolchain, `pkg-config`, OpenSSL development headers, Git, and `nvm` installed and loaded in the current shell. On macOS: Xcode command-line tools plus `nvm` installed and loaded. The commands below assume `nvm --version` succeeds before the Node.js step. Do not install secrets or create a funded wallet during DEV-01/DEV-02.

```sh
# Rust host toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup toolchain install 1.95.0 --profile minimal --component rustfmt,clippy

# Agave/Solana CLI, exact stable release
sh -c "$(curl -sSfL https://release.anza.xyz/v4.2.2/install)"

# AVM from the exact Anchor release; avoid the floating master installer/nightly channel
cargo +1.95.0 install --git https://github.com/otter-sec/anchor \
  --tag v1.2.0 avm --locked --force
avm nightly --disable || true
avm install 1.2.0
avm use 1.2.0

# Node/npm with nvm; repository files will select the same Node version later
nvm install 24.21.0
nvm use 24.21.0
npm install --global npm@11.19.0
```

The implementation must add these pins:

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.95.0"
profile = "minimal"
components = ["rustfmt", "clippy"]
```

```text
# .anchorversion
1.2.0
```

```text
# .nvmrc and .node-version
24.21.0
```

```toml
# Anchor.toml excerpt
[toolchain]
anchor_version = "1.2.0"
solana_version = "4.2.2"

[provider]
cluster = "Devnet"
wallet = "~/.config/solana/id.json"
```

The provider is Devnet-only. The wallet path is a local convention; no keypair, seed phrase, `.env`, RPC token or generated `target/deploy/*-keypair.json` may be committed.

Root `package.json` must be private and declare `"packageManager": "npm@11.19.0"`. It must not declare workspaces until at least one real JavaScript package exists. The intended future workspace locations are:

```json
[
  "apps/dashboard",
  "packages/circuits",
  "packages/verifier"
]
```

Keep the root `package-lock.json` aligned with `package.json`. Add workspace entries only when package manifests contain real scripts, dependencies or implementation. Use exact versions for hackathon-critical dependencies, including `anchor-lang = "=1.2.0"`, `anchor-spl = "=1.2.0"` when first needed, `@anchor-lang/core` 1.2.0 when first needed, and `groth16-solana = "=0.2.0"` in DEV-15. Keep Cargo and npm lockfiles committed.

## Monorepo boundary

Create this structure and no feature implementation:

```text
apps/ios/
apps/dashboard/
tools/device-sim/
firmware/esp32/
packages/circuits/
packages/verifier/
programs/pathnod/
docs/
```

Conventions:

- One root Git repository.
- One root Cargo workspace with `members = ["programs/*"]`, resolver `2`, and release overflow checks enabled.
- One root npm toolchain definition. The dashboard, circuits tooling and verifier may become npm workspaces once implemented; Swift and ESP-IDF projects are not npm workspaces.
- `programs/pathnod` is a minimal buildable Anchor program. It may expose one no-op/initialization instruction solely to prove the toolchain; no registry, verifier, escrow, nullifier or payment behavior belongs in DEV-02.
- Unimplemented component directories are retained with `.gitkeep` only. Do not generate Xcode projects, ESP-IDF applications, Circom circuits, Next.js UI or verifier logic until those components are implemented.
- Add only justified root files: `Anchor.toml`, `Cargo.toml`, `package.json`, lockfiles, `.anchorversion`, `.nvmrc`, `.node-version`, `rust-toolchain.toml`, `.gitignore`, `.editorconfig`, and concise bootstrap instructions in `README.md`.
- Do not add Docker, databases, CI, deployment manifests, wallets, generated proofs/keys, `.zkey`, `.ptau`, build outputs or environment files in this task. Those require concrete later use cases.
- Use `Pathnod`/`pathnod` consistently. Do not propagate the legacy product name `Sovel` from the presentation document.

## Verification contract

Run from the repository root after DEV-01/DEV-02 implementation.

### 1. Exact versions

```sh
rustc --version                 # rustc 1.95.0 (...)
cargo --version                 # cargo 1.95.0 (...)
solana --version                # solana-cli 4.2.2 (... Agave)
avm list                        # 1.2.0 installed and selected
anchor --version                # anchor-cli 1.2.0
node --version                  # v24.21.0
npm --version                   # 11.19.0
```

A mismatch is a failed check; do not silently continue with a newer version.

### 2. Program build — required path

When `target/deploy/pathnod-keypair.json` is absent, Anchor 1.2.0 generates an ignored local keypair and synchronizes its public ID into `programs/pathnod/src/lib.rs` and `Anchor.toml` before compilation. Verification must therefore run from a disposable archive, not from a checkout that may contain user changes:

```sh
(
  set -eu
  verify_dir="$(mktemp -d)"
  trap 'rm -rf "$verify_dir"' EXIT HUP INT TERM
  git archive HEAD | tar -x -C "$verify_dir"
  cd "$verify_dir"
  anchor build
  anchor build --tools-version v1.57 --arch v3
)
```

Both builds must succeed and produce the program `.so` and IDL inside the disposable directory. The shell trap removes that directory even if a command fails or is interrupted. Never copy or commit the generated keypair, verification-only program ID, rewritten source/configuration or artifacts. The real checkout and any pre-existing user changes remain untouched.

This verification behavior is separate from the shared deployment-ID lifecycle. A deployment owner must deliberately select the intended local keypair, run `anchor keys sync`, review the resulting public-ID changes, and commit those public changes only when required. The keypair itself must never be committed.

### 3. Documented fallback

If `anchor build` fails because of the Anchor wrapper/IDL step, preserve its full log and try only the lower-level program build:

```sh
cargo build-sbf \
  --manifest-path programs/pathnod/Cargo.toml \
  --tools-version v1.57 \
  --arch v3
```

The fallback is diagnostic, not an alternative definition of done:

- If both commands fail, DEV-01 is blocked.
- If `cargo build-sbf` succeeds but `anchor build` fails, DEV-01 is still blocked; report the Anchor/IDL failure instead of claiming success.
- Do not change versions until the failure is reproduced from a clean checkout and recorded.

### 4. Repository checks

For the current scaffold, which has no npm workspaces or package scripts, run:

```sh
cargo +1.95.0 fmt --all -- --check
cargo +1.95.0 check --workspace --locked
npm ci
npm ls --all
git diff --check
git status --short
```

Once real JavaScript packages and their build or test scripts exist, also run:

```sh
npm run build --workspaces --if-present
npm test --workspaces --if-present
```

Also confirm every required top-level directory exists and that Git contains no generated keypairs, `.env` files, `.so` binaries, `target/`, `node_modules/`, `.zkey`, `.ptau`, Xcode DerivedData or ESP-IDF build output.

### 5. Future Groth16 compatibility gate (DEV-15)

Before implementing Pathnod verification logic, add exactly `groth16-solana = "=0.2.0"` to a minimal branch, keep platform-tools `v1.57`/arch `v3`, and require all of:

1. `anchor build --tools-version v1.57 --arch v3` succeeds.
2. A known-valid snarkjs proof verifies locally and through the Solana program.
3. Public inputs are 32-byte big-endian field elements.
4. The client-side proof A point is negated as required by the crate example.
5. Devnet verification stays below the roadmap's 300k CU target, with a 400k compute limit instruction placed before the program instruction.

Failure of this spike is a documented blocker for DEV-15. It is not permission to upgrade or downgrade the shared toolchain without a new ADR.

## Repository policy and document inconsistencies

- Repository inspection at commit `bbe103ebcf5ca32450b4baab2a8538e5eaab836b`: README contains only the project title/tagline; LICENSE is Apache-2.0; no `CONTRIBUTING.md`, `.github` policy or AI-disclosure rule is present.
- The supplied technical spec and roadmap use `Pathnod`, but the presentation repeatedly uses the legacy name `Sovel`. Code, directories, package names and new documentation must use `Pathnod` only.
- The spec's provisional BLE UUID starts with ASCII `SOVEL` (`534F5645-4C...`) despite the rename. Do not change it in DEV-02; flag it for the already-listed post-hackathon UUID decision, or for an explicit protocol-versioning decision before BLE implementation.
- The spec says ESP-IDF/NimBLE with “libsodium-port or monocypher”, while the roadmap selects libsodium. Keep `libsodium` as the implementation choice unless the firmware spike proves it unavailable for the selected ESP-IDF target.
- The roadmap mentions SQLite/Postgres for the verifier. No database belongs in DEV-02; that choice can be made when verifier persistence is implemented.

## Sources consulted

Official/current sources:

- Anchor changelog (1.2.0, 2026-09-04): https://github.com/otter-sec/anchor/blob/v1.2.0/CHANGELOG.md
- Anchor CLI build flags/defaults: https://www.anchor-lang.com/docs/references/cli
- Solana Foundation compatibility matrix: https://github.com/solana-foundation/solana-dev-skill/blob/main/skills/solana-dev/references/compatibility-matrix.md
- Agave cluster version floor: https://github.com/anza-xyz/agave/wiki/feature-gate-tracker-schedule
- Platform-tools v1.57 compiler source: https://github.com/anza-xyz/platform-tools/blob/v1.57/build.sh
- Rust 1.95.0 release: https://blog.rust-lang.org/2026/04/16/Rust-1.95.0/
- Node 24 LTS archive (`24.21.0`, npm `11.19.0`): https://nodejs.org/en/download/archive/v24
- `groth16-solana` 0.2.0 manifest and compiler notes: https://github.com/Lightprotocol/groth16-solana/blob/v0.2.0/Cargo.toml
- `groth16-solana` 0.2.0 API/example: https://docs.rs/groth16-solana/0.2.0/groth16_solana/groth16/index.html

Project inputs:

- Roadmap Pathnod PDF
- Pathnod Spec PDF
- Pathnod presentation PDF
- Pathnod development, risks and business/communication CSV exports
- Repository README, LICENSE and Git metadata at the commit above

## Implementation checklist

- [ ] Add all pin/config files exactly as specified.
- [ ] Scaffold only the agreed directories and minimal Anchor program.
- [ ] Update README with installation, version checks, Devnet-only warning and build commands.
- [ ] Generate and commit Cargo/npm lockfiles; exclude all build artifacts and secrets.
- [ ] Run every applicable verification command above and retain real output in the DEV-01/DEV-02 handoff.
- [ ] Do not upgrade versions during the hackathon; use a new ADR for any evidence-driven exception.
