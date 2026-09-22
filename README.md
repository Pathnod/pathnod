# Pathnod

Pathnod explores privacy-preserving observations of physical infrastructure,
with registry and accounting on Solana.

The project asks whether a phone can report that it was near a specific piece of
equipment without revealing its owner or a history of other observations. Its
design combines a local BLE exchange, hardware-backed observer attestation,
zero-knowledge mechanisms for uniqueness and privacy, and on-chain accounting.

## Intended model

1. **Local challenge/response.** A nearby phone sends a fresh challenge over BLE,
   and the infrastructure device signs a response with its local key.
2. **Observer attestation.** The phone supplies a hardware-backed platform signal
   to make software-only observation farms harder to operate.
3. **Zero-knowledge proof.** The observer proves an eligible response while
   limiting disclosure, and derives a nullifier for duplicate detection.
4. **Registry and accounting.** A Solana program is intended to track registered
   devices, accepted observations, and operator-funded rewards.

These mechanisms can provide useful signals, not absolute guarantees. They do
not prove an exact location, prevent every relay or proxy, rule out collusion,
or make fraud impossible. Extracted device keys, compromised phones, radio
relays, and dishonest operators remain part of the threat model.

## Repository map

```text
apps/ios/            iOS observer app
apps/dashboard/      operator dashboard
firmware/esp32/      BLE device firmware
tools/device-sim/    device simulator
packages/circuits/   zero-knowledge circuits and proving tools
packages/verifier/   off-chain verifier
programs/pathnod/    Solana program
docs/                architecture decisions and project notes
```

## Current status

Pathnod is at an early scaffold stage. The intended protocol above is not a
running system yet.

- The iOS app, dashboard, firmware, simulator, circuits, and verifier are
  placeholders.
- `programs/pathnod` is a minimal buildable Anchor scaffold with no registry,
  proof verification, nullifier, reward, or payment logic.
- The repository currently establishes component boundaries and a reproducible
  development toolchain.

## Getting started

The repository pins Rust, Solana/Agave, Anchor, Node.js, and npm versions. Use
the exact versions declared by the root configuration files.

```sh
npm ci
```

For installation, version checks, isolated Anchor builds, and the local program
ID lifecycle, follow
[ADR 0001](docs/decisions/0001-toolchain-and-monorepo.md). The Solana provider
is configured for Devnet only.

Never commit keypairs, seed phrases, environment files, RPC tokens, proving
artifacts, or build output.

## Documentation

- [Toolchain and monorepo baseline](docs/decisions/0001-toolchain-and-monorepo.md)

## Contributing

The architecture and protocol are still evolving. Changes should keep claims
aligned with implemented behavior and document important technical decisions
under `docs/`.

## License

Apache-2.0. See [LICENSE](LICENSE).
