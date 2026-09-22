# Security review — DEV-08 foreground BLE density scanner

Date: 2026-09-22
Reviewed commit: `a75f31a6a927db4d26c94a788e3945ca8d6fc900`
Base commit: `66350faa340940fc7b0be27e09806103dbb6feb8`
Scope: Pathnod issue #7, including BLE lifecycle, classification, privacy, export schema, project configuration and tests.
Verdict: **REQUEST CHANGES**

## Critical

No critical finding identified.

## High

No high finding identified.

## Medium

### M1 — An active session is not interrupted when CoreBluetooth becomes unknown

Location: `apps/ios/App/DensityScan/BLEScanController.swift:482-519`

`apply(state:)` maps `.unknown` and future unknown states to `RadioAvailability.unknown`, but the following switch does nothing for that availability. If an active scan transitions from `.poweredOn` to `.unknown`, the accumulator stays in `scanning`, its timer continues increasing `foregroundScanSeconds`, and a later `.poweredOn` state calls `beginScanIfPossible()` automatically. The UI can therefore claim foreground scanning time while radio availability is unknown, and recovery does not require the explicit Resume required by issue #7.

Required fix: distinguish the initial manager state from loss of availability during an active session. Any non-ready state during `scanning`, including `.unknown` and `@unknown default`, must stop the scan, stop timing, increment the interruption count once and require explicit Resume. Add controller tests for scanning → unknown → powered-on and scanning → future/unknown state behavior through an injectable CoreBluetooth boundary.

### M2 — Equal-priority conflicts across separate sightings do not fail closed

Locations:

- `apps/ios/Sources/PathnodDensityCore/AdvertisementClassifier.swift:39-60`
- `apps/ios/Sources/PathnodDensityCore/SessionAccumulator.swift:227-244`
- `apps/ios/Tests/PathnodDensityCoreTests/SessionAccumulatorTests.swift:175-238`

The classifier correctly returns `unknown/ambiguous-match` when one advertisement matches equal-priority rules from different categories. The accumulator does not preserve that fail-closed rule across sightings of the same peripheral. `ClassificationOutcome.supersedes` ranks every clean match above every ambiguous match, and equal-priority clean matches are resolved by confidence and rule ID without considering a category conflict.

A peripheral can therefore be attributed to Helium after one packet matches Helium and another packet at the same priority matches EV, depending on packet composition and order. The test named `ambiguityDoesNotDisplaceAMatch` explicitly locks in this non-fail-closed result.

Required fix: aggregate evidence per peripheral at the highest observed priority. If different categories have evidence at that priority, classify the peripheral as `unknown/ambiguous-match` until genuinely higher-priority evidence resolves it. Make the result independent of packet order. Add tests for conflicts arriving in separate advertisements in both orders, including clean → ambiguous, ambiguous → clean and clean category A → clean category B.

### M3 — A committed hosted app test is guaranteed to fail

Locations:

- `apps/ios/App/DensityScanTests/DensityScanAppTests.swift:97-104`
- `apps/ios/App/DensityScan/ClassificationRules.swift:51-59`

`sourceReferenceStatesItsLimits` requires the literal substring `spoofable`, while the committed source reference says `can be spoofed`. This assertion is false for the shipped rule, so the required Xcode scheme tests cannot pass unchanged.

Required fix: align the assertion and source wording while retaining a substantive check that the export states the signature can be imitated and is not evidence of network membership. Run the hosted tests on an available simulator and attach the result.

### M4 — Foreground duration uses the adjustable wall clock

Location: `apps/ios/Sources/PathnodDensityCore/SessionAccumulator.swift:133-142, 249-295`

Both timestamps and elapsed scan duration use `Date`. Manual time changes, network time corrections or daylight-independent clock adjustments during a session can add or remove scan duration. Flooring a negative final interval at zero does not repair accumulated segments or a forward jump. This can materially corrupt the main two-hour measurement.

Required fix: inject separate wall-clock and monotonic time sources. Use wall time only for `startedAt` and `endedAt`; use a monotonic clock for foreground and wall-duration measurements. Add tests for forward and backward wall-clock changes while scanning and while interrupted.

## Low

### L1 — Hosted cache tests share one process-wide directory and can race

Locations:

- `apps/ios/App/DensityScan/ExportDocument.swift:37-75`
- `apps/ios/App/DensityScanTests/DensityScanAppTests.swift:231-342`

Every `DensityExportStore()` uses the same `Caches/DensityExports` directory. Swift Testing may execute tests concurrently, and each `BLEScanController` clears that directory during initialization. A controller test can delete a cache test's file between write and assertion, producing nondeterministic failures.

Required fix: allow tests to inject a unique base directory or directory name into `DensityExportStore`, and inject the same isolated store into each controller test. Keep a separate integration test for the real caches-directory location.

### L2 — Future manufacturer rules copy the complete raw payload before narrowing it

Locations:

- `apps/ios/App/DensityScan/BLEScanController.swift:431-436`
- `apps/ios/Sources/PathnodDensityCore/DensityModels.swift:86-93, 316-328`

The current shipped ruleset has no manufacturer rule, so this path is inactive in this build. If a manufacturer rule is added, `[UInt8](raw)` copies the complete advertisement data and `ManufacturerData(rawAdvertisementBytes:)` copies the entire company payload before the registry truncates it to the longest required prefix. That is broader inspection and transient retention than the stated rule of reading only bytes required by active rules.

Required fix: parse the two-byte company identifier directly from `Data`, reject undeclared companies, then copy only the maximum required prefix. Add a test with a large suffix proving that only the declared prefix enters the snapshot.

### L3 — The deduplication map has no defensive bound

Location: `apps/ios/Sources/PathnodDensityCore/SessionAccumulator.swift:145-147, 227-245`

The session retains one dictionary entry for every distinct `CBPeripheral.identifier` until reset. A busy environment or an advertiser rotating identities can grow memory for the full two-hour run. This is acknowledged as a residual risk but is not measured or handled.

Required fix: measure peak memory during the required two-hour physical rehearsal. Define a fail-safe upper bound or resource-pressure policy that stops/finalizes with an explicit limitation instead of allowing process termination and total loss of the in-memory study.

## Verified controls

Static review found no committed background mode, state-restoration key, location permission, local-network permission, tracking permission, BLE connection call, network upload, analytics/telemetry integration, Team ID, provisioning profile, signing identity, UDID or credential in the reviewed change.

The app wraps `CBPeripheral.identifier` immediately in a non-Codable redacted key, does not read peripheral names or RSSI, ships only the documented Helium configuration-service rule, leaves Wi-Fi and EV unclassified, exports aggregate schema-v1 fields only, uses complete file protection for its cache file, and clears its export cache on launch, new session and Delete.

The Foundation-only core passed 74 Swift Testing tests in both Debug and Release using Swift 6.0. The monorepo typecheck, build, 44 Node tests and dependency audit passed. Swift parser checks passed for the app and hosted-test sources. Asset JSON and Xcode scheme/workspace XML parsed successfully. The canonical full Swift package command was attempted but remains blocked on Linux by the preserved `PathnodAttestation` target importing Apple CryptoKit.

## Required platform evidence

This review cannot approve acceptance criteria that require Apple hardware. Before approval, return redacted evidence for the exact corrected commit:

- successful `swift test --package-path apps/ios --filter PathnodDensityCoreTests` on macOS;
- successful generic iOS Simulator build and hosted scheme tests;
- Personal Team signing, physical-device build and installation without committed signing identifiers;
- fresh permission prompt, denied/restricted, Bluetooth-off and recovery behavior;
- explicit interruption and Resume after app switching and screen lock;
- five-minute scan, deduplication and unknown-classification checks;
- schema-v1 export, reconciliation and privacy inspection;
- Delete/new-session cache clearing;
- two-hour foreground rehearsal with memory, battery, thermal, crash and export observations.
