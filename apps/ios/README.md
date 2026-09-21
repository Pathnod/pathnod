# apps/ios

Placeholder. Nothing is implemented here yet.

Planned stack: a native iOS app in Swift/SwiftUI using CoreBluetooth,
DeviceCheck and mopro to talk to Pathnod beacons, collect presence attestations
and request local proof generation.

Scope reserved for later roadmap tasks:

- BLE central role: scan, connect, challenge/response with the ESP32 firmware.
- Local custody of the user's identity material and witness data.
- Proof request handoff to the proving tooling in `packages/circuits`.

Deliberately out of scope for DEV-01/DEV-02: no Xcode project, no Swift package
and no BLE code. See `docs/decisions/0001-toolchain-and-monorepo.md`. This
directory is not an npm workspace and is not part of the Cargo workspace.

The provisional BLE service UUID in the spec still encodes the legacy product
name; that UUID decision is open and must be settled before BLE work starts.
