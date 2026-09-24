# Security review — DEV-08 foreground BLE density scanner

Date: 2026-09-22
Reviewed commit: `e3fa2f91280157b6e1baab910a6779f0953833b0`
Remediation base: `f9513cfe0394da66a18489a5b368a7c480bef2c9`
Previous reviewed implementation: `ff674825f01806da509897c479a777f2ad4d1bb5`
Previous review report: `be1483287d92bdbc3a07d9af9335965f7b6017e0`
Scope: the latest DEV-08 remediation, plus regression checks for the scanner's BLE lifecycle, classification, timing, privacy, export schema, resource bounds, project configuration and tests.
Verdict: **PASS**

## Critical

No critical finding identified.

## High

No high finding identified.

## Medium

No medium finding identified.

## Low

No low finding identified in the reviewed remediation.

## Remediation verification

### Stale-ready Resume is fail-closed

`resume()` and `canResume` now use the same `isRadioReadyNow` condition. It requires both the last published availability to allow scanning and the central manager's live state to be `.poweredOn` immediately before the accumulator can return to `scanning` (`BLEScanController.swift:194-205`, `325-327`, `360-368`).

The hosted controller test covers stale published readiness with live `.unknown` and `.poweredOff`. A refused Resume leaves the session interrupted, keeps the interruption count at one, credits no additional foreground time and starts no second scan (`DensityScanAppTests.swift:532-566`).

### Unknown future CoreBluetooth states use the production fallback

The controller maps raw CoreBluetooth state values through one production function. Every value not named by the current SDK maps to `.unknown` (`BLEScanController.swift:541-551`). The previous core test that compared `.unknown` with itself is gone.

Hosted tests pass out-of-range raw values through that mapping and through the controller transition. An unnamed state interrupts an active scan exactly once, stops the active scan once, remains interrupted after powered-on recovery and requires explicit Resume before scanning restarts (`DensityScanAppTests.swift:568-621`).

### Pending Start is cancellable

The controller exposes `cancelPendingStart()` and the view presents Cancel while the initial Start is waiting on an unknown radio state (`BLEScanController.swift:208-218`, `DensityScanView.swift:252-261`).

The hosted test covers Start → unknown → cancel → Start → powered-on. Cancellation returns to idle, creates no interruption, starts no scan and permits a new Start (`DensityScanAppTests.swift:623-653`).

### Every clock chooses its duration source explicitly

`DensityClock.monotonicSeconds` has no protocol-extension default. `SystemDensityClock`, the hosted controller clock and both core test clocks implement it explicitly (`SessionAccumulator.swift:11-47`, `DensityScanAppTests.swift:343-354`, `DensityTestSupport.swift:21-59`). The shipped clock still measures durations with `ContinuousClock`; civil `Date` remains a timestamp source only.

### Raw manufacturer data remains bounded to active rule prefixes

`ManufacturerData.init(rawAdvertisementBytes:)` is removed. Fixtures construct already-split company/payload values explicitly. The only app path from a raw manufacturer field is `ClassificationRegistry.manufacturerDataToInspect(rawAdvertisement:)`, which rejects fields shorter than the company identifier, rejects undeclared companies before copying payload bytes and copies at most the longest prefix required by an active rule (`DensityModels.swift:74-91`, `313-329`; `ClassificationTests.swift:231-274`).

### Earlier controls remain intact

The concurrent `f9513cf` advertiser-limit warning remains visible and persistent while scanning, interrupted and finished, then clears on Delete/reset (`AdvertiserLimitWarning.swift:3-18`, `DensityScanView.swift:22-24`, `DensityScanAppTests.swift:667-689`).

Cross-sighting equal-priority category conflicts remain ambiguous until genuinely higher-priority evidence appears (`ContendedEvidenceTests.swift:50-109`). Export-store tests still use isolated temporary containers. Retained identities remain bounded at 50,000, later new-identity sightings are counted as discarded rather than retained, and limited sessions remain valid exports with an explicit lower-bound limitation (`SessionAccumulator.swift:324-393`, `DensityExportTests.swift:108-135`).

## Security and privacy controls

No injection sink, authentication or authorization surface exists in this scanner. No secret, Team ID, provisioning profile, signing identity, UDID or new third-party dependency was found in the reviewed range. The project keeps automatic signing without committed team data.

The app declares no Bluetooth background mode or state restoration, location permission, local-network permission, tracking permission or Live Activity. It performs no GATT connection and contains no network or telemetry path for scanner data.

The shipped ruleset reads advertised service UUIDs only. Local names, RSSI, location, addresses and unrelated raw advertisement fields are not retained. Peripheral identifiers remain wrapped in a non-Codable redacted key and live only in the bounded in-memory deduplication map.

Exports remain aggregate schema-v1 documents. Category and rule totals must reconcile, foreground duration cannot exceed wall duration, invalid documents are refused, cached files use complete file protection, and the cache is cleared on launch, Delete and new session. A capped session remains exportable and explicitly states that its totals are a floor.

## Verification performed on Linux

- Reviewed the exact remediation delta from `f9513cf` to `e3fa2f9`, the prior findings, and the preserved scanner controls.
- Copied the Foundation-only density core and its tests unchanged into an isolated Swift 6.0 package. All **103 tests passed** in Debug and Release.
- Re-attempted `swift test --package-path apps/ios --filter PathnodDensityCoreTests` with a fresh scratch path. SwiftPM stopped in the preserved `PathnodAttestation` target because CryptoKit is unavailable in the Linux Swift image.
- Parsed all **24** app, core and test Swift sources with `swiftc -frontend -parse` in the Swift 6.0 container.
- Strict recursive `swift format lint` passed for the density app, hosted tests, core and core tests.
- `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm audit` passed; the Node suite reports **44/44 tests** and no known vulnerabilities.
- Static project/privacy checks passed: PBX reference closure, scheme references, assets, target membership, local package, iOS 16, exact permission text, no signing identifiers, background/location capabilities or remote Swift packages, Foundation-only core, preserved DEV-05 and scoped secret/artifact scan.
- `git show --check` and `git diff --check` passed for the reviewed commit/range.

These checks validate portable logic and static configuration. They are not macOS, simulator or iPhone evidence.

## Apple-platform evidence outstanding at the original review

At the Linux review, the following acceptance evidence was pending for exact
commit `e3fa2f91280157b6e1baab910a6779f0953833b0`:

- successful `swift test --package-path apps/ios --filter PathnodDensityCoreTests` on macOS;
- successful generic iOS Simulator build and hosted scheme tests;
- Personal Team signing, physical-device build and installation without committed signing identifiers;
- fresh permission prompt, denied/restricted, Bluetooth-off, resetting, unknown and recovery behavior;
- lifecycle interruption after app switching and screen lock, with explicit Resume and no false scanning state;
- five-minute scan, deduplication and unknown-classification checks;
- schema-v1 export, reconciliation, privacy inspection, Delete and new-session cache clearing;
- visible lower-bound warning when the retained-identity limit is exceeded;
- two-hour foreground rehearsal with peak memory near the advertiser bound, battery, thermal, crash and final export observations;
- hardware confirmation that scan stopping remains correct when CoreBluetooth changes state and `CBCentralManager.isScanning` changes around the callback.

### Subsequent manual validation

I completed Mac/Xcode and physical-iPhone testing successfully
on application commit `8416873812610440731d943c9367ee0ddec5d992`. I checked
Swift Debug/Release and Xcode tests, build and installation,
Bluetooth permission/recovery, foreground lifecycle and explicit Resume,
classification/deduplication with a LightBlue advertiser on iPad, aggregate
export and reset, and the foreground rehearsal. See the updated acceptance
matrix in [ADR 0003](decisions/0003-foreground-ble-density-scan.md).

This update records my manual validation; it does not repeat or extend
the security review above. I added screenshots to PR #10. I have not
attached raw artifacts or quantitative measurements here, or separately
documented managed-device restricted states, induced radio reset/unknown
callback races, or physical-device stress near the 50,000-identity bound.
