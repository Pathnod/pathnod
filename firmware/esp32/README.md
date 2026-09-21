# firmware/esp32

Placeholder. Nothing is implemented here yet.

Planned stack: ESP-IDF firmware for an ESP32 beacon, using NimBLE for the BLE
peripheral role and libsodium for cryptography.

Scope reserved for later roadmap tasks:

- BLE peripheral advertising and the beacon challenge/response protocol.
- Key storage and signing on device.
- Provisioning and firmware update strategy.

Deliberately out of scope for DEV-01/DEV-02: no ESP-IDF project, no BLE code and
no build system. See `docs/decisions/0001-toolchain-and-monorepo.md`.

Two open points are recorded in that ADR: libsodium stays the implementation
choice unless a firmware spike proves it unavailable for the selected ESP-IDF
target, and the provisional BLE service UUID from the spec still encodes the
legacy product name and must be revisited before BLE work starts.

This directory is not an npm workspace and is not part of the Cargo workspace.
