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
3. **Zero-knowledge proof.** The observer proves membership in the enrolled
   observer tree and derives a nullifier and a protocol-scoped pseudonym.
4. **Registry and accounting.** A Solana program is intended to track registered
   devices, accepted observations, and operator-funded rewards.

These mechanisms can provide useful signals, not absolute guarantees. They do
not prove an exact location, prevent every relay or proxy, rule out collusion,
or make fraud impossible. Extracted device keys, compromised phones, radio
relays, and dishonest operators remain part of the threat model.

## Repository map

```text
apps/ios/            Swift packages, the density scanner, and the S1 challenge app
apps/dashboard/      operator dashboard
firmware/esp32/      BLE device firmware
tools/device-sim/    device simulator
packages/circuits/   zero-knowledge circuits and proving tools
packages/verifier/   off-chain verifier
packages/solana/     registry instruction builders and chain validation tools
programs/pathnod/    Solana program
docs/                architecture decisions and project notes
```

## Current status

Pathnod is at an early development stage. The intended protocol above is not a
running system yet.

- `packages/verifier` validates Apple App Attest attestation and assertions,
  using an Apple root certificate and a SQLite store for one-time challenges,
  verified keys, and assertion counters. The [DEV-19 runbook](docs/dev19-app-attest-server.md)
  documents the iPhone proof and remaining integration limits. DEV-26 adds
  commitment enrollment, a persistent depth-20 Poseidon tree and authenticated
  Merkle-path refresh; see the [enrollment runbook](docs/dev26-observer-enrollment-service.md).
  [DEV-28](docs/dev28-root-publication.md) adds automatic batched root publication,
  durable retries and chain-checked publication status, validated on devnet with
  the recorded iPhone enrollment root.
  [DEV-29](docs/dev29-device-eligibility.md) adds public device-slot eligibility
  queries backed by the protocol/device registry and optional epoch counters.
- `apps/ios` holds a Swift package for the density study, challenge protocol,
  and `PathnodAppAttest` client. The
  [App Attest spike](apps/ios/AppAttestSpike/README.md) exercises Apple's
  generation APIs on a supported iPhone and can export local evidence for the
  verifier. The S1 challenge app also supports persistent observer credentials
  and enrollment against the DEV-26 service.
  [DEV-30](docs/dev30-observation-session.md) adds a foreground observation
  collector with eligibility, observer-bound challenges, optional coarse signals
  and a persistent local cache. Physical validation passes; the original <5 s
  collection target remains unmet with the unchanged firmware.
  [DEV-31](docs/dev31-observation-transcript.md) converts verified captures into
  canonical Borsh transcripts with credential-bound nullifiers and matching
  Swift/TypeScript serialization and hashes.
  [DEV-32](docs/dev32-observation-submission.md) adds the Mopro submission adapter,
  transcript-bound App Attest assertion, protected persistent outbox and an
  explicitly loopback-only development HTTP receipt sink. Receipt is not policy
  approval, an on-chain observation or payment; complete acceptance is DEV-33.
- `PathnodDensityScan` is a measurement instrument for a two-hour field study,
  not the observer app: it counts BLE advertisers visible while it is open,
  never connects, never runs in the background, never asks for location, and
  exports aggregate counters only. It carries no App Attest integration and none
  of the production discovery protocol. See
  [ADR 0003](docs/decisions/0003-foreground-ble-density-scan.md), including the
  limits that have not been verified yet.
- The DEV-05 development attestation stub was retired in DEV-19. Its original
  design is preserved as a historical record in
  [ADR 0002](docs/decisions/0002-development-attestation.md).
- The circuits implement a depth-20 observation circuit and a development-only
  Groth16 setup/proof harness. See the [circuits README](packages/circuits/README.md).
- `firmware/esp32` provides DEV-20/21/22 ESP-IDF/NimBLE discovery and persistent
  Ed25519 identity baseline, with separate development/protected storage
  profiles, plus GATT challenge/response signing over `SHA-256(DEV_MSG_V0)`,
  replay/rate guards and NVS-backed monotonic counters. CI enforces the revised
  1 MiB application binary budget. Full global rate-limit and interrupted NVS
  commit validation remain open. See the
  [firmware README](firmware/esp32/README.md) for build and iPhone validation.
- `programs/pathnod` includes protocol configuration, SPL escrow creation,
  requester-authorized device registration and enrollment-authorized global
  observer roots. [DEV-27](docs/dev27-protocol-registry.md) documents the accounts
  and chain validation. The older Groth16/nullifier submission spike still uses
  caller-selected keys and does not validate observations against this registry.
  Reward distribution and withdrawals are not implemented yet.
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
- [Historical development attestation stub](docs/decisions/0002-development-attestation.md)
- [Foreground BLE density scan](docs/decisions/0003-foreground-ble-density-scan.md)
- [DEV-15 Solana Groth16 verification spike](docs/dev15-solana-groth16.md)
- [DEV-16 observation submission spike](docs/dev16-observation-submit.md)
- [DEV-17 Gate 1 decision](docs/gates/dev17-gate1.md)
- [DEV-18 iPhone App Attest spike](apps/ios/AppAttestSpike/README.md)
- [DEV-19 App Attest server verification](docs/dev19-app-attest-server.md)
- [DEV-26 observer enrollment service](docs/dev26-observer-enrollment-service.md)
- [DEV-27 protocol and device registry](docs/dev27-protocol-registry.md)
- [DEV-28 batched observer-root publication](docs/dev28-root-publication.md)
- [DEV-29 device observation-slot eligibility](docs/dev29-device-eligibility.md)
- [DEV-30 iPhone observation session](docs/dev30-observation-session.md)
- [DEV-31 canonical observation transcript](docs/dev31-observation-transcript.md)

## Contributing

The architecture and protocol are still evolving. Changes should keep claims
aligned with implemented behavior and document important technical decisions
under `docs/`.

## License

Apache-2.0. See [LICENSE](LICENSE).
