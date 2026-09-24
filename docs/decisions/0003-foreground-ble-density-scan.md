# ADR 0003 — Foreground BLE density scan

- Status: accepted for DEV-08 (issue #7)
- Date: 2026-09-22
- Scope: a standalone S0 measurement app. GATT challenge/response (DEV-10), App
  Attest (DEV-18/DEV-19), the production UUID-filtered Pathnod scan, circuits,
  the Solana program and the verifier stay out.

## Decision

Ship an installable iOS app, `PathnodDensityScan`, that counts how many distinct
BLE advertisers a phone can see while the app is open, and exports the totals.
It exists to answer one question before the protocol work continues: is there
enough BLE density on a real route to make a field study worth running?

It is a measurement instrument, not a product feature. It never connects, never
runs in the background, never asks for location, and never records anything that
identifies a device or a person.

## What "visible" means

An advertiser is counted when CoreBluetooth reports an advertisement to an
active foreground scan. That is the whole claim. It does not establish that the
device belongs to any network, is online, is reachable, belongs to anyone in
particular, or is at any particular place. Nothing in this app measures
distance, position or ownership.

## Layout

```text
apps/ios/Package.swift                       PathnodAttestation + PathnodDensityCore
apps/ios/Sources/PathnodDensityCore/         Foundation only, no CoreBluetooth, no UI
apps/ios/Tests/PathnodDensityCoreTests/      swift test
apps/ios/Pathnod.xcodeproj                   PathnodDensityScan app + app tests
apps/ios/App/DensityScan/                    SwiftUI, CoreBluetooth, lifecycle, sharing
apps/ios/App/DensityScanTests/               Xcode test bundle, hosted by the app
```

`PathnodAttestation` from ADR 0002 is untouched: same product, same sources,
same tests, same behaviour. `PathnodDensityCore` is a second, independent
product in the same package.

The app target consumes `PathnodDensityCore` as a local Swift package product.
The package root is `apps/ios`, which is also the directory holding
`Pathnod.xcodeproj`, so the project's `XCLocalSwiftPackageReference` has
`relativePath = "."`.

No third-party dependency is added anywhere. The deployment target stays
iOS 16.0.

## Privacy model

The rules the code is written to, in the order they matter:

1. **`CBPeripheral.identifier` is a deduplication key and nothing else.** It is
   wrapped in `PeripheralKey` on the line it is read. That type is not
   `Codable`, keeps its value private, and prints as `PeripheralKey(redacted)`,
   so it cannot be persisted, logged, displayed, hashed into an export, or
   exported — not by intent and not by accident.
2. **Only the advertisement fields an active rule needs are read.**
   `ClassificationRegistry` publishes `inspectsServiceUUIDs` and
   `inspectedCompanyIdentifiers`; the app reads the advertised service UUIDs
   only if some rule declares one, and manufacturer bytes only for a company
   some rule declares — and then only as many bytes as the longest declared
   prefix. The ruleset this build ships declares one service UUID and no company
   identifier, so the advertised service list is read and no manufacturer byte
   ever is.
3. **The local name is never read.** The app does not access
   `CBAdvertisementDataLocalNameKey`, because no active rule requires it.
4. **Nothing else is touched.** No RSSI, no transmit power, no connectable flag,
   no solicited services, no service data, no overflow list, no raw dictionary.
   `didDiscover` does not retain the `CBPeripheral`.
5. **No location, ever.** The app requests no location permission, links no
   location framework, and stores no coordinate, geohash, SSID or BSSID.
6. **Nothing is persisted.** The deduplication map and the counters live in
   memory for the length of the session. A JSON file is produced in the app's
   caches directory on Export, and that directory is deleted on launch, on
   Delete, and whenever a session starts.
7. **Logs carry state transitions and aggregate counters only** — session
   started, interrupted with a reason, finished with the totals, radio state,
   export size. No identifier, no advertisement field, no name.

The consequence is stated rather than engineered around: **if iOS terminates the
process, an unfinished session is lost.** Surviving that would mean writing
third-party device identifiers to disk, which is exactly what this app refuses
to do.

There is no telemetry, no analytics, no network code and no upload path of any
kind.

## No background claim

`scanForPeripherals(withServices: nil, options: [allowDuplicates: true])` runs
only while the scene phase is `.active`. The app declares no `UIBackgroundModes`
(and therefore no `bluetooth-central`), no `CBCentralManagerOptionRestore-
IdentifierKey`, and no Live Activity. `.inactive` and `.background` both stop
the scan, increment the interruption counter, and leave the session in a state
that only an explicit Resume can leave. Aggregates collected before an
interruption are preserved.

Duplicate advertisements are allowed so that a later, stronger advertisement can
reclassify a peripheral already counted. That costs battery, which is why the
acceptance matrix includes a two-hour rehearsal with battery and thermal
observations.

The session clock starts when the radio reports that it can scan, not when the
Start button is tapped. Answering the first permission prompt takes the app
through `.inactive`, and counting that as an interruption — or counting the
seconds spent in the prompt as foreground scanning — would be wrong.

## Classification, and what this build ships

A rule may only exist when a published specification or a written partner
confirmation states that a specific device advertises a specific service UUID,
or a specific company identifier followed by specific bytes. Every rule carries
`id`, `category`, `confidence`, `sourceKind`, `sourceReference`, its exact
criteria and a priority, and the registry validates the whole set at
construction: a blank version, a blank identifier, a duplicate identifier, a
duplicate signature, the reserved `unknown` category, a missing source
reference, a rule with no criteria, an empty manufacturer data prefix and a
negative priority are all rejected. There is no partial acceptance.

Matching is deliberately narrow:

- A company identifier on its own is never a signature. Companies ship unrelated
  products behind one identifier.
- A local name, an RSSI and undocumented bytes are never inputs.
- A rule that names both a service UUID set and a manufacturer signature needs
  both.
- The highest priority wins. Two categories tied at the highest matching
  priority produce `unknown` with reason `ambiguous-match`.
- A later advertisement may only sharpen what is known about a peripheral, never
  weaken it, and the four category counters always sum to `uniqueAdvertisers`.

**`ClassificationRules` is version `1.0.0` and contains exactly one rule**,
`helium-hotspot-config-service-v1`: the Helium Hotspot BLE configuration service
UUID `0fda92b2-44a2-4af2-84f5-fa682baa2b8d`, cross-checked in Helium's official
client and advertising peripheral sources at immutable revisions. It is a `published-spec` rule at
`high` confidence and priority 100, matching on the service UUID alone.

That confidence is in the *signature*, not in the sighting. The source reference
carries its three limits into every export that cites it:

- the service is advertised only while a Hotspot is offering configuration over
  BLE, so a session counting zero of them has not shown that no Hotspot is
  nearby;
- anything at all can advertise this UUID, so a match is spoofable;
- a match describes a configuration window, never network membership, activity,
  ownership or location.

**No Wi-Fi and no EV rule is shipped**, and that absence is the outcome of the
review rather than an unfinished task:

- Consumer Wi-Fi access points, when they advertise at all, do so under
  provisioning profiles shared with unrelated products from the same vendor, so
  only a company identifier would be available — and a company identifier alone
  is not a signature.
- BLE on EV chargers is a vendor extension in practice. OCPP defines no
  advertising signature.

So `wifi` and `ev` will read zero in every export this build produces, and
everything that is not a configuring Helium Hotspot is reported as `unknown`.
The study therefore measures BLE density, not network membership. That is why
the export carries `rulesetVersion` and the `byRule` breakdown: a later build
with more rules produces comparable numbers only if the ruleset is named.

Because the single rule is a service-UUID rule and no rule declares a company
identifier, the app reads the advertised service UUID list and nothing else. No
manufacturer byte is ever parsed by this build.

If a ruleset is ever rejected at launch, the app falls back to
`ClassificationRegistry.unavailable`, shows a banner, and keeps counting with
everything `unknown`. It never falls back to a guess.

## Export schema v1

UTF-8 JSON, keys sorted, pretty printed, byte-identical across two exports of
the same session. The stored properties of `DensityExportV1` are the schema, so
a field that is not declared cannot appear:

`schemaVersion` (`1`), `sessionId` (random per session), `scanMode`
(`foreground-generic-ble`), `rulesetVersion`, `appVersion`, `startedAt`,
`endedAt` (RFC 3339, UTC), `wallClockSeconds`, `foregroundScanSeconds`,
`interruptionCount`, `uniqueAdvertisers`, `counts`
(`helium`/`wifi`/`ev`/`unknown`), `byRule`, `limitations`.

A `byRule` row carries `ruleId`, `category`, `confidence`, `sourceKind`,
`sourceReference` and `count`. Zero-count rows are omitted. There is no
per-device array and no raw advertising field.

`limitations` is part of the file rather than part of a README, so a number
cannot be quoted without the caveat that goes with it: foreground BLE only, a
rule match is not verified membership, no location and no device identifiers.

An export is refused, not truncated, when the session is not finished, a
timestamp is missing or reversed, the app version is blank, the category
counters do not sum to `uniqueAdvertisers`, the `byRule` counts do not sum to
the classified total, or a zero-count row is present.

## Permission string

The app declares exactly one usage description,
`NSBluetoothAlwaysUsageDescription`:

> Pathnod uses Bluetooth to count nearby BLE advertisers during a foreground
> density study. It does not connect to devices or export identifiers.

It is set through `INFOPLIST_KEY_NSBluetoothAlwaysUsageDescription` in both
configurations, and the app test bundle compares the value in `Bundle.main`
against that text character for character. The same suite asserts that
`UIBackgroundModes`, every location usage description,
`NSLocalNetworkUsageDescription`, `NSBluetoothPeripheralUsageDescription`,
`NSSupportsLiveActivities` and `NSUserTrackingUsageDescription` are absent.

## Initial platform gaps

The following records the initial Linux-only validation, before the Mac and
iPhone checks reported below. Pending statements in this historical list refer
to that initial review, not the current validation status. The architecture host
had no macOS, Xcode, simulator, code signing or iPhone:

- The Foundation-only `PathnodDensityCore` sources and tests were copied
  unchanged into an isolated Swift 6.0 Linux package and compiled successfully;
  all 73 core tests passed. App Swift files were also accepted by
  `swiftc -frontend -parse`. This validates core syntax and behaviour, not Apple
  framework integration.
- The canonical
  `swift test --package-path apps/ios --filter PathnodDensityCoreTests` command
  was attempted in the official Swift 6.0 Linux container. SwiftPM also tried to
  compile the existing `PathnodAttestation` target and stopped because CryptoKit
  is unavailable there. The same command still has to pass on the Mac.
- `Pathnod.xcodeproj` was written by hand, because there is no Xcode here to
  write it. Its object graph was parsed successfully with the Ruby `xcodeproj`
  library, and its scheme/workspace XML and asset JSON were validated. The first
  thing to check on the Mac is still that the local package reference resolves:
  open the project and confirm `PathnodDensityCore` appears under Package
  Dependencies and is linked by both targets. If Xcode does not resolve
  `relativePath = "."`, re-add the package with *File › Add Package Dependencies
  › Add Local* pointing at `apps/ios`, and commit whatever spelling Xcode writes.
- No `xcodebuild` invocation has run. The SwiftUI/CoreBluetooth app and its
  hosted tests have not been type-checked or linked against Apple SDKs.
- CoreBluetooth behaviour, the permission flow, the lock and app-switch
  interruptions, battery and thermal behaviour, and the export and share sheets
  cannot be observed anywhere except on a physical iPhone. A simulator has no
  BLE radio: a green simulator run says the app builds and the logic runs, and
  says nothing at all about scanning.
- The acceptance matrix below is therefore pending, not passed.

### Mac and iPhone validation update

I completed the guided Mac, simulator and physical-iPhone validation
successfully for application commit
`8416873812610440731d943c9367ee0ddec5d992`, using Xcode 26.6. I checked
Swift package tests in Debug and Release, Xcode build and hosted tests, device
signing and installation, and the manual sequence below. This is my manual
validation record; it does not extend the original security review. I kept
local signing settings and Xcode's project serialization changes outside the
committed project.

I tested classification and deduplication with an iPad running LightBlue
as a controlled BLE advertiser. Its service UUID must be present in the
advertisement received by the scanner, not merely in the peripheral's GATT
service list. Keep LightBlue in the foreground during this test. A simulated
Helium signature validates classification, not real Hotspot or network density.

I added screenshots to PR #10. I have not attached device/OS details, raw
test logs, exports or quantitative battery/thermal observations to this record.

## Validation procedure on Mac and iPhone

Prerequisites: a stable Xcode, a connected and trusted physical iPhone,
Developer Mode enabled if Xcode asks, Bluetooth on, and an Apple Account added
to Xcode.

Record versions rather than assuming them:

```sh
mkdir -p "$HOME/Desktop/pathnod-dev08-evidence"
git rev-parse HEAD | tee "$HOME/Desktop/pathnod-dev08-evidence/commit.txt"
xcodebuild -version | tee "$HOME/Desktop/pathnod-dev08-evidence/xcode-version.txt"
sw_vers | tee "$HOME/Desktop/pathnod-dev08-evidence/macos-version.txt"
xcrun devicectl list devices | tee "$HOME/Desktop/pathnod-dev08-evidence/devices.txt"
```

Redact UDIDs and personal device names before sharing any of it.

Pure Swift tests, and the simulator build:

```sh
swift test --package-path apps/ios --filter PathnodDensityCoreTests
xcodebuild -project apps/ios/Pathnod.xcodeproj -scheme PathnodDensityScan \
  -destination 'generic/platform=iOS Simulator' build
xcrun simctl list devices available
xcodebuild -project apps/ios/Pathnod.xcodeproj -scheme PathnodDensityScan \
  -destination 'platform=iOS Simulator,name=<AVAILABLE_SIMULATOR>' test
```

Simulator success does not validate BLE.

### Signing

Open `apps/ios/Pathnod.xcodeproj`, enable **Automatically manage signing**,
select the Personal Team, and set a bundle identifier that is unique to this
device, for example `xyz.pathnod.densityscan.kazai777`. The committed default is
`xyz.pathnod.densityscan`; change it locally and do not commit the change.
Confirm that **Background Modes** is not in Signing & Capabilities. Select the
iPhone and Run.

No Team ID, Apple Account or signing identity is committed:
`DEVELOPMENT_TEAM` is absent from the project and `CODE_SIGN_STYLE` is
`Automatic`.

A paid Apple Developer membership is not assumed. **Personal Team provisioning
is sufficient, and expires after seven days:** the App ID, the registered device
and the provisioning profile all lapse, after which the app stops launching and
must be rebuilt and reinstalled from Xcode. A Personal Team also supports no App
Store, no TestFlight, no ad-hoc distribution and no testers other than the
registered device. Plan the two-hour field study inside a seven-day window, and
expect to reinstall if it slips. App Attest is not part of this spike.

Treat a Personal Team signing error as a blocker: return the exact redacted
error rather than adding paid entitlements or changing scope.

After the first Xcode Run, capture a command-line device build (substitute the
local UDID and redact it in anything shared):

```sh
xcodebuild -project apps/ios/Pathnod.xcodeproj -scheme PathnodDensityScan \
  -configuration Debug -destination 'platform=iOS,id=<IPHONE_UDID>' \
  -derivedDataPath "$HOME/Desktop/pathnod-dev08-derived" \
  -allowProvisioningUpdates build \
  | tee "$HOME/Desktop/pathnod-dev08-evidence/device-build.log"

xcrun devicectl device install app --device '<IPHONE_UDID>' \
  "$HOME/Desktop/pathnod-dev08-derived/Build/Products/Debug-iphoneos/PathnodDensityScan.app"
```

### Manual sequence

1. Delete and reinstall to get the first Bluetooth prompt. Capture allowed,
   denied/restricted, Bluetooth-off and recovery states.
2. Run a five-minute foreground outdoor scan. Check that a repeated known
   advertiser increments the unique count once, and that unrecognised
   advertisers stay `unknown`.
3. Switch apps once and lock the screen once. Check that scanning stops, that no
   background counting is claimed, that Resume is explicit, that the
   interruption count rises, and that the prior in-memory aggregates survive.
4. Stop, export the JSON to Files and over AirDrop, then Delete and confirm the
   result is gone.
5. Validate the file on the Mac:

   ```sh
   python3 -m json.tool <export>
   python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["schemaVersion"]==1; assert sum(d["counts"].values())==d["uniqueAdvertisers"]' <export>
   ```

6. Inspect the export and the redacted logs for peripheral identifiers, device
   names, addresses, raw manufacturer or service payloads, location fields or
   per-device rows. The random session UUID and public rule references are
   expected and are not peripheral identifiers.
7. Run the two-hour foreground rehearsal. Record crashes, process termination,
   battery drain, thermal warnings, counter freezes and export success.

Return privately: the commit, Xcode and macOS files; redacted devices, build and
test logs; the iPhone model and iOS version; the signing method and its expiry
date; screenshots of the permission prompt, the state and counters, an
interruption and the final summary; the aggregate export; the validation output;
and the completed matrix. Never post an unredacted Apple Account, Team ID,
certificate, UDID or personal path.

## Physical-device acceptance matrix

The results below record my successful guided manual validation. I have not
attached supporting artifacts here or separately documented restricted-device
policy states beyond the denied-permission test.

| # | Check | Status |
|---|---|---|
| 1 | Fresh permission prompt shows the committed explanation | passed manually |
| 2 | Allowed scan advances elapsed time and counters | passed manually |
| 3 | Denied or restricted never pretends to scan | denied passed manually; restricted not separately documented |
| 4 | Bluetooth off then on recovers with an explicit Start or Resume | passed manually |
| 5 | A repeated known advertiser is counted once | passed manually; controlled iPad advertiser |
| 6 | A matched rule reports only rule, source and confidence, in aggregate | passed manually; simulated Helium signature |
| 7 | An unrecognised advertiser stays `unknown` | passed manually |
| 8 | App switch and screen lock interrupt without a background claim | passed manually |
| 9 | Resume preserves the in-memory aggregates | passed manually |
| 10 | Export is schema v1 and the totals reconcile | passed manually |
| 11 | Export and log privacy inspection passes | passed manually |
| 12 | Delete and New session clear the state | passed manually |
| 13 | Two-hour foreground rehearsal exports without crashing; battery and thermal recorded | rehearsal passed manually; measurements not attached |

## Field-study handoff

Ready means: the signed development build is installed, Bluetooth permission is
granted, a short rehearsal and export have passed, and the tester understands
that the app must stay open, and knows Stop, Export and Delete.

The field-study report that follows must record the commit, the app and ruleset
versions, Xcode, iPhone, iOS, the signing method and its expiry, the route and
any manually measured distance or area, timestamps and foreground duration,
permission, interruption, crash, battery and thermal evidence, the aggregate
totals with the rule and confidence breakdown, the expected partner or test
devices, the unknown share, the BLE-only and non-location caveats, and the
decision — including a missions-first fallback if density is near zero.

DEV-08 does not fabricate field measurements. This ADR now records a reviewed
implementation and my Mac/iPhone validation. A measured field-study
report remains separate from the controlled classification test.
