# Security review — DEV-08 foreground BLE density scanner

Date: 2026-09-22
Reviewed commit: `ff674825f01806da509897c479a777f2ad4d1bb5`
Base commit: `a75f31a6a927db4d26c94a788e3945ca8d6fc900`
Previous review: `d31cc7f29f93063461a591116ff9570c77df0325`
Scope: Pathnod issue #7 remediation, including BLE lifecycle, classification, timing, privacy, export schema, resource bounds, project configuration and tests.
Verdict: **REQUEST CHANGES**

## Critical

No critical finding identified.

## High

No high finding identified.

## Medium

### M1 — Resume can enter `scanning` after the radio has already become unavailable

Locations:

- `apps/ios/App/DensityScan/BLEScanController.swift:190-200`
- `apps/ios/App/DensityScan/BLEScanController.swift:306-308`
- `apps/ios/App/DensityScan/BLEScanController.swift:341-346`

`resume()` and `canResume` trust the last published `availability`, while `beginScanIfPossible()` reads the central manager's live state. A CoreBluetooth state change can therefore occur before its main-queue delegate callback is delivered. In that window, the UI can still enable Resume and `resume()` moves the accumulator to `scanning`, starts the elapsed-time ticker and publishes that state, while `beginScanIfPossible()` refuses to start the radio scan because `central.currentState` is no longer `.poweredOn`.

The queued state callback should normally interrupt the session again, but this still creates a false scanning state, an extra interruption and potentially unearned foreground time. If the callback is delayed, the false state lasts with it. This breaks the controller's stated invariant that it never reports scanning it is not doing.

Required fix: require both `availability.allowsScanning` and `central.currentState == .poweredOn` before enabling or executing Resume. Keep the final check immediately before changing the accumulator state, and add a hosted test where published availability is still ready but the injected central has already moved to unknown or powered-off.

## Low

### L1 — The future CoreBluetooth-state test does not exercise a future state

Location: `apps/ios/Tests/PathnodDensityCoreTests/RadioGateTests.swift:57-72`

`futureUnknownFallbackIsEquivalent()` calls `RadioGate.decide` twice with the same `.unknown` input. It cannot detect a regression in the controller's `@unknown default` mapping and does not satisfy the previous review's requested controller coverage for a future `CBManagerState`.

Required fix: replace the tautological comparison with a hosted controller test that supplies an out-of-range raw `CBManagerState` through `applyRadioState`, then asserts availability becomes unknown, an active session is interrupted once, and powered-on recovery still requires Resume. If the SDK does not permit construction of an unknown raw case, isolate the mapping behind a testable function and test its fallback directly.

### L2 — A pending Start has no cancellation path

Locations:

- `apps/ios/App/DensityScan/BLEScanController.swift:149-170`
- `apps/ios/App/DensityScan/DensityScanView.swift:209-258`

When Start leaves the controller waiting on an initial `.unknown` radio state, the primary button becomes disabled and Stop is hidden because the accumulator is still idle. If CoreBluetooth does not deliver another state callback, the user cannot cancel the pending request or retry without relaunching the app.

Required fix: expose a cancel action while `isAwaitingRadio` is true that clears the pending Start without creating an interruption. Add a hosted test for Start → unknown → cancel → Start.

### L3 — The clock protocol silently falls back to civil time

Location: `apps/ios/Sources/PathnodDensityCore/SessionAccumulator.swift:27-34`

`DensityClock` documents `monotonicSeconds` as a monotonic source, but its protocol extension defaults that property to `now.timeIntervalSinceReferenceDate`. A future conformer can omit the requirement accidentally and reintroduce the wall-clock duration bug without a compiler error. The shipped `SystemDensityClock` is correct, so this is a latent maintenance risk rather than a defect in the current runtime path.

Required fix: remove the default implementation. Make every conformer choose an explicit duration source; the civil-only fault-injection test double can implement the wall-clock behavior locally.

### L4 — A public initializer still copies an entire manufacturer payload

Location: `apps/ios/Sources/PathnodDensityCore/DensityModels.swift:86-93`

The app path now reads the company identifier from `Data`, rejects undeclared companies and copies only the required prefix. However, `ManufacturerData.init(rawAdvertisementBytes:)` remains public and copies every remaining byte. It is unused by the app and currently appears only in core tests, but it preserves an easy API path for future code to bypass the new data-minimization boundary.

Required fix: remove this initializer or reduce its visibility to test-only/internal use. Construct test fixtures with `ManufacturerData(companyIdentifier:payload:)` instead.

## Prior findings

| Prior finding | Status at `ff674825` | Evidence |
|---|---|---|
| Active scanning → unknown/future state interrupts once and requires Resume | **Implementation closed; required future-state test incomplete** | `RadioGate` interrupts every non-ready state only while scanning; controller unknown and repeated-unknown coverage passes. The committed “future state” test is tautological; see L1. |
| Equal-priority category conflicts across sightings remain ambiguous | **Closed** | `ClassificationOutcome.merging` retains ambiguity at the highest observed priority; grouped/split and order permutations are covered by `ContendedEvidenceTests`. |
| Hosted limitation wording | **Closed** | Source reference and hosted assertion both use “can be spoofed” and state that a match is not evidence of membership, activity, ownership or location. |
| Monotonic duration | **Closed for the shipped clock** | `SystemDensityClock` uses `ContinuousClock`; civil time is read once for the timestamp anchor; discontinuity tests pass. The protocol default remains a low latent risk; see L3. |
| Isolated export paths | **Closed** | Hosted tests inject unique containers and retain a separate check for the real caches location. |
| Manufacturer payload prefix-only copy | **Closed for the app path** | The registry rejects undeclared companies before copying and retains only the longest active prefix. The old public full-copy initializer remains a low latent risk; see L4. |
| Bounded dedup with explicit valid-export limitation | **Closed in code** | New identities are capped at 50,000, discarded sightings saturate safely, reconciliation remains valid, and truncated exports carry an explicit limitation. Physical peak-memory evidence remains pending. |

## Verified controls

No injection sink, authentication or authorization surface exists in this scanner. No secret, Team ID, provisioning profile, signing identity, UDID or dependency change was found in the reviewed range. The project declares automatic signing without committed team data.

The shipped ruleset reads advertised service UUIDs only. It does not read local names, RSSI, location, addresses or raw manufacturer data. It never connects to a peripheral. Peripheral identifiers remain wrapped in a non-Codable redacted key and are retained only in the bounded in-memory deduplication map.

Exports remain aggregate schema-v1 documents. Category and rule totals must reconcile, invalid documents are refused, cached files use complete file protection, and the cache is cleared on launch, Delete and new session. A capped session remains exportable and states that its totals are a floor.

## Verification performed on Linux

- Reviewed the full change from `a75f31a6` to `ff674825`, then the remediation delta from `d31cc7f` to `ff674825`.
- Copied the Foundation-only core and its tests unchanged into an isolated Swift 6.0 package. All **104 tests passed** in Debug and Release.
- Re-attempted `swift test --package-path apps/ios --filter PathnodDensityCoreTests` in a fresh Swift 6.0 environment. SwiftPM again stopped in the preserved `PathnodAttestation` target because Apple CryptoKit is unavailable on Linux.
- Parsed all app and hosted-test Swift sources with `swiftc -frontend -parse`.
- `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm audit` passed; the Node suite reports **44/44 tests** and no known vulnerabilities.
- Static checks found no background mode, state restoration, location permission, local-network permission, tracking permission, BLE connection, network upload, telemetry integration or committed signing identifier.
- `git diff --check` passed for the reviewed range.

These checks validate portable logic and static configuration. They are not macOS, simulator or iPhone evidence.

## Required Apple-platform evidence

The following acceptance evidence remains pending for the exact corrected commit produced after this review:

- successful `swift test --package-path apps/ios --filter PathnodDensityCoreTests` on macOS;
- successful generic iOS Simulator build and hosted scheme tests;
- Personal Team signing, physical-device build and installation without committed signing identifiers;
- fresh permission prompt, denied/restricted, Bluetooth-off, resetting, unknown and recovery behavior;
- lifecycle interruption after app switching and screen lock, with explicit Resume and no false scanning state;
- five-minute scan, deduplication and unknown-classification checks;
- schema-v1 export, reconciliation, privacy inspection, Delete and new-session cache clearing;
- two-hour foreground rehearsal with peak memory near the advertiser bound, battery, thermal, crash and final export observations;
- hardware confirmation that scan stopping remains correct when CoreBluetooth changes state and `CBCentralManager.isScanning` changes around the callback.
