# DEV-30 — foreground iPhone observation collection

The ChallengeScan app's **Observe a device** screen runs filtered discovery,
INFO validation, eligibility, three signed challenges and local-signal collection.
The completed session is stored locally for the later transcript/proof flow.
This increment does not submit an observation or make a payment. Canonical Borsh
encoding remains DEV-31; assertion, proof and submission remain DEV-32.

## Flow and privacy

1. Review what is collected and choose optional location/motion signals and whether
   to allow unpaid collection. The app requests optional sensor permissions before
   starting; a denied or unavailable sensor remains absent.
2. Prepare the connection to the configured service through `/health`, without
   sending observer or device data. Then scan only the provisional Pathnod service.
3. Connect, read INFO and recompute the device ID. When Service Data is available,
   its eight-byte prefix must match INFO. The device's `protocol_hint` is not used
   as a protocol ID: Helium emulation may put an external asset reference there.
4. Request DEV-29 eligibility for the device. The five JSON fields stay unchanged;
   `X-Pathnod-Epoch-Seconds` provides the protocol's duration. If the initial
   seven-day lookup used a different epoch, the app requeries the correct one.
   Inconsistent settings, unknown devices or failed requests stop before challenges.
5. Derive the protocol-scoped pseudonym from the Keychain credential. Challenges
   use the real epoch and `pseudonym[0..8]` as `obs_hint`, with fresh CSPRNG nonces.
6. Subscribe to responses alongside eligibility, then perform three sequential
   exchanges with the existing **2.25 s spacing**. Each signature and claimed
   monotonic counter is checked. Observation collection requires full notifications;
   S1's diagnostic read fallback remains available only for the S1 test.
7. Collect real connected-device RSSI readings concurrently (5–20 samples).
   Each challenge also records the most recent RSSI. Optional sensors supply a
   geohash6 with accuracy, pressure in hPa ×10 and motion class 0–3.
8. Validate and atomically save the completed capture before reporting success.
   A later run for the same credential/protocol/device/epoch restores that capture
   and sends no fresh challenges.

Only the device ID, epoch and optional protocol selector are sent to eligibility.
The local session contains public device data, signed responses, pseudonym and
chosen coarse signals. It never contains the observer secret, App Attest key ID
or precise coordinates. Location callbacks convert coordinates immediately to
geohash6; unavailable location/pressure/motion and unobserved Wi-Fi have explicit
zero encodings. The summary copied by the app omits the geohash and pseudonym.
Turning off the privacy acknowledgment during a running collection cancels it.

The app remains foreground-first. Leaving the foreground cancels the operation;
initial Bluetooth/local-network permission alerts can pause preparation. Stale
network completions are guarded by a run token and cannot start a later session.
Failed or interrupted sessions do not create completed-cache entries.

## Core types and cache

`PathnodObservationCore` provides epoch/identity handling, the eligibility client,
local-signal encoding, a verified `ObservationCapture`, and a file-backed cache.
The capture retains INFO and all original nonce/response bytes, conservative
integer RTTs and RSSI values required by DEV-31. Reload rechecks signatures,
device identity, nonce uniqueness, claimed counters, epoch consistency, signal
bounds and the 400 ms median RTT limit.

Cache keys hash the public credential commitment, protocol ID, full device ID
and epoch. A different credential or protocol cannot reuse another scope's entry.
The production cache is `Application Support/Pathnod/observation-sessions-v1.json`,
written atomically with complete iOS file protection and excluded from backups.
It contains completed captures rather than a boolean, so closing the app does
not discard the data needed by the next stage. Entries are bounded to 256 and
pruned after two protocol epochs. The capture preserves its original observation
time; future submission must still enforce freshness and on-chain uniqueness.
This cache is not the DEV-32 submission/retry queue.

The pseudonym uses the spec's domain-separated Poseidon formulas:

```text
protocol_id_f = Poseidon(3, high128(protocol_id), low128(protocol_id))
pseudonym     = Poseidon(2, s_obs, protocol_id_f)
obs_hint      = pseudonym[0..8]
```

The enrollment hash stays compatible with DEV-25. Field multiplication uses
four-limb Montgomery reduction to avoid the initial repeated-doubling loop.
The public t4 constants and 64 context / 32 field vectors are generated from
`circomlibjs 0.1.7`; the latter include zero and modulus-minus-one cases. Regenerate:

```sh
pnpm --filter @pathnod/circuits exec node scripts/dev30-observer-context.mjs
swift test --package-path apps/ios
```

The fixture secrets are explicitly public synthetic test inputs, not real
credentials. Real Keychain secrets, app captures and signing material are never
inputs to that generator or committed to Git.

## Development run

Build the SDK and verifier, then use the DEV-26 enrollment settings with DEV-29
eligibility settings for a protocol where the ESP32's actual public key is
registered. The app uses the same saved service URL as enrollment.

```sh
pnpm --filter @pathnod/solana build
pnpm --filter @pathnod/verifier build
```

For a `.local` development host, binding the server to `::` accepts both IPv6 and
IPv4. An IPv4-only listener caused the iPhone to retry advertised IPv6 addresses
during validation. The UI accepts local `.local` HTTP only in Debug; release
usage requires HTTPS.

Build/install with the existing ChallengeScan scheme and the owner's development
team. No team, device UDID, signing certificate or provisioning profile is pinned
or checked into this change. Keep the ESP32 firmware unchanged and close other
BLE clients before running. Open **Observe a device**, review privacy, choose the
optional signals and tap **Observe nearby device**.

The optional physical app test is disabled by default. For an unlocked paired
iPhone and a running development server:

```sh
TEST_RUNNER_PATHNOD_DEV30_HARDWARE=1 \
TEST_RUNNER_PATHNOD_DEV30_SERVER_URL=http://YOUR_MAC.local:8787 \
xcodebuild test -project apps/ios/Pathnod.xcodeproj -scheme PathnodChallengeScan \
  -destination 'id=YOUR_IPHONE_UDID' -derivedDataPath /private/tmp/pathnod-dev30-device \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=YOUR_TEAM \
  '-only-testing:PathnodChallengeScanTests/ChallengeScanAppTests/physicalObservation()'
```

`TEST_RUNNER_PATHNOD_DEV30_PROBE=1` expects an unregistered device and zero writes.
`TEST_RUNNER_PATHNOD_DEV30_EXPECT_CACHED=1` expects a restored session and zero new
challenges. `TEST_RUNNER_PATHNOD_DEV30_CLEAR_CACHE=1` clears only the test cache,
which is separate from the production cache. Logs, result bundles and signing
artifacts must remain outside Git. The test's duration is reported, not asserted
below five seconds after the owner's acceptance of the deviation.

CI runs Swift package tests and an unsigned app build on macOS. Physical tests
require the actual hardware and are not presented as hosted-CI coverage.

## Physical validation — 2026-10-06

The existing ESP32-C3 firmware was preserved, including its Helium emulation
capabilities and rate limits. A test protocol and its actual public key were
registered on the existing DEV-27 devnet program. The eligibility service read
those accounts; the session used the real iPhone Keychain credential. No synthetic
device signature or eligibility response was substituted.

| Check | Result |
| --- | --- |
| Unregistered device | INFO read, eligibility false, **zero challenge writes** |
| Registered device | Three genuine ESP32 signatures verified; real epoch/hint |
| Earlier measured collection | **6,522 ms**, median notification RTT **40 ms**, **5 RSSI samples** |
| Final full app test run | **8 tests passed**; collection **8,340 ms**, median RTT **39 ms**, **6 RSSI samples** |
| Relaunch/cache | Capture restored; **zero new challenges**; about **3.37 s** including preparation and discovery |
| Optional location/motion | Disabled for the hardware run; zero/absent values verified; encodings covered by unit tests |

**The original <5 s connection-to-collection target is not met.** An instrumented
run spent about 1.35 s establishing BLE, 0.47 s on INFO/service preparation and
0.09 s on eligibility before the two 2.25 s pacing waits and final reply. Earlier
IPv4-only `.local` setup also caused network retries. Both connection-to-collection
and overall preparation/discovery/collection are reported separately; the slower
startup is not hidden in RTT. Durations vary between runs.

The owner explicitly chose to keep the tested firmware and document the timing
deviation as nonblocking for this increment. Advertising/connection and total
session optimization remain follow-up work; no firmware constraint was weakened
to claim the target was achieved. This validation does not measure background
discovery, distance bounding, an on-chain accepted observation or a reward.
