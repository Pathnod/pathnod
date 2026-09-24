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
apps/ios/            Swift packages and the foreground BLE density-scan app
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

- `packages/verifier` implements the development-only attestation verifier:
  envelope parsing, strict unpadded base64url decoding, and a constant-time
  proof comparison. It has no HTTP endpoint, storage, or real provider.
- `apps/ios` holds a Swift package with two products — `PathnodAttestation`, the
  attestation provider contract and its development-only stub, and
  `PathnodDensityCore`, the Foundation-only classification, accumulation and
  export logic of the density study — plus `Pathnod.xcodeproj` and the
  `PathnodDensityScan` app that uses them.
- `PathnodDensityScan` is a measurement instrument for a two-hour field study,
  not the observer app: it counts BLE advertisers visible while it is open,
  never connects, never runs in the background, never asks for location, and
  exports aggregate counters only. It carries no App Attest integration and none
  of the production discovery protocol. See
  [ADR 0003](docs/decisions/0003-foreground-ble-density-scan.md), including the
  limits that have not been verified yet.
- Both sides only implement the development stub, which carries no hardware
  assurance. See
  [ADR 0002](docs/decisions/0002-development-attestation.md).
- The dashboard, firmware, simulator, and circuits are placeholders.
- `programs/pathnod` is a minimal buildable Anchor scaffold with no registry,
  proof verification, nullifier, reward, or payment logic.
- The repository currently establishes component boundaries and a reproducible
  development toolchain.

## Getting started

The repository pins Rust, Solana/Agave, Anchor, Node.js, and pnpm versions. Use
the exact versions declared by the root configuration files.

```sh
corepack enable
pnpm install --frozen-lockfile
```

For installation, version checks, isolated Anchor builds, and the local program
ID lifecycle, follow
[ADR 0001](docs/decisions/0001-toolchain-and-monorepo.md). The Solana provider
is configured for Devnet only.

Never commit keypairs, seed phrases, environment files, RPC tokens, proving
artifacts, or build output.

## Documentation

- [Toolchain and monorepo baseline](docs/decisions/0001-toolchain-and-monorepo.md)
- [Development-only attestation stubs](docs/decisions/0002-development-attestation.md)
- [Foreground BLE density scan](docs/decisions/0003-foreground-ble-density-scan.md)

## Contributing

The architecture and protocol are still evolving. Changes should keep claims
aligned with implemented behavior and document important technical decisions
under `docs/`.

## License

Apache-2.0. See [LICENSE](LICENSE).
