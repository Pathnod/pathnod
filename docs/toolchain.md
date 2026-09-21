# Pinned toolchain

Pathnod freezes its on-chain build toolchain for the duration of the hackathon.

## Versions

- Rust: `1.88.0`
- Solana CLI (Agave): `2.3.0`
- Anchor CLI and `anchor-lang`: `0.32.1`
- pnpm: `10.6.5`

These values are encoded in `rust-toolchain.toml`, `.anchorversion`, `Anchor.toml`, `programs/pathnod/Cargo.toml`, and `package.json`.

## Installation

AVM is the source of truth for Anchor and the project-specific Solana CLI:

```sh
cargo install --git https://github.com/otter-sec/anchor avm --force
avm install 0.32.1
avm use 0.32.1
avm solana install 2.3.0
```

Confirm every version before building:

```sh
rustc --version
solana --version
anchor --version
pnpm --version
```

Expected values are Rust `1.88.0`, Solana `2.3.0`, Anchor `0.32.1`, and pnpm `10.6.5`.

## Build

```sh
anchor build
```

If Anchor's wrapper fails during the hackathon, use the documented fallback while keeping the same pinned Solana toolchain:

```sh
cargo build-sbf --manifest-path programs/pathnod/Cargo.toml
```
