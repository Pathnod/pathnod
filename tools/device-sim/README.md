# tools/device-sim

Placeholder. Nothing is implemented here yet.

Planned stack: a Swift macOS simulator using CoreBluetooth's
`CBPeripheralManager` to impersonate a Pathnod beacon so the iOS app, circuits
and verifier can be exercised without physical ESP32 hardware.

Scope reserved for later roadmap tasks:

- Replay the beacon challenge/response protocol over BLE or a local transport.
- Emit deterministic test vectors for the proving and verification paths.

Deliberately out of scope for DEV-01/DEV-02: no simulator code and no protocol
implementation. See `docs/decisions/0001-toolchain-and-monorepo.md`.

This directory is intentionally neither an npm workspace (the root workspace
covers only `apps/dashboard`, `packages/circuits` and `packages/verifier`) nor a
Cargo workspace member (the root workspace covers only `programs/*`).
