# Pathnod

Privacy-preserving proof of presence for physical infrastructure, built on Solana.

## Toolchain

The hackathon toolchain is intentionally pinned and must not be upgraded without an explicit team decision.

| Tool | Version |
| --- | --- |
| Rust | `1.88.0` |
| Solana CLI | `2.3.0` |
| Anchor CLI / crates | `0.32.1` |
| pnpm | `10.6.5` |

Install the pinned Anchor and Solana versions with AVM:

```sh
avm install 0.32.1
avm use 0.32.1
avm solana install 2.3.0
```

Then verify the program scaffold:

```sh
anchor build
```

See [`docs/toolchain.md`](docs/toolchain.md) for the complete reproducibility notes.
