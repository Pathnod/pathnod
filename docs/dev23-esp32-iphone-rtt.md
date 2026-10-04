# DEV-23 — iPhone ↔ ESP32 challenge test

DEV-23 replaces the macOS simulator with the real ESP32 firmware for the S1
challenge flow (Spec §2, §4.4). The DEV-10 `PathnodChallengeScan` app connects
to the board, reads INFO, sends three fresh challenges and verifies each
Ed25519 response on the iPhone. Acceptance: **median notification RTT below
150 ms** against the ESP32, without disabling any firmware limit.

This is a protocol and timing check in the foreground. It is not distance
bounding, not a relay test and not a background-discovery measurement.

## App changes

- **Pacing.** DEV-22 firmware accepts at most one challenge every two seconds
  per connection (Spec §2.3). `ChallengeSession` now refuses a write less than
  `defaultChallengeSpacingSeconds` (2.25 s) after the previous one, and the
  controller waits for `nextChallengeAllowedAt` before writing. The 250 ms
  margin absorbs radio scheduling, which can shorten the gap seen by the
  board. The wait happens before `t0`, so it is never part of the RTT.
- **Counter.** When INFO claims capability bit 1, each response counter must be
  strictly greater than the previous one in the session (the same rule as the
  verifier's `E_DEV_COUNTER`, Spec §7.1). Gaps are accepted: the firmware
  reserves counters in blocks of 64. Without bit 1 (macOS simulator) the
  counter is informational.
- **Identity.** The app recomputes `device_id = SHA-256("Pathnod/device/v0" ||
  K_dev)` from INFO and compares its first eight bytes with the advertised
  Service Data. A mismatch fails the session. The macOS simulator cannot send
  Service Data, so the result is reported as "not advertised" rather than
  matched.
- **Scan response grace.** The ESP32 puts Service Data in its scan response.
  The app scans with duplicates allowed and waits up to
  `serviceDataGraceSeconds` (3 s) for a callback carrying it before connecting
  without it. A first version waited 1 s and missed the scan response in one
  of five hardware sessions (see results); at 1 Hz advertising a missed scan
  response costs about one second.
- **Display.** The app shows the device ID prefix, identity check, capabilities,
  protocol hint and ATT MTU, the counter of each response, and a
  **Copy results** button that produces the plain-text records below.

## Reproduce

1. Build and flash the DEV-22 development profile (no eFuse is programmed);
   see [the firmware README](../firmware/esp32/README.md):

   ```sh
   . ~/esp/esp-idf/export.sh   # ESP-IDF v5.5.1, fcae32885b0296b32044cb99ecbdc50d98dddb83
   cd firmware/esp32
   idf.py -B build-c3 -D SDKCONFIG=sdkconfig.c3.local \
     -D SDKCONFIG_DEFAULTS=sdkconfig.defaults set-target esp32c3
   idf.py -B build-c3 -D SDKCONFIG=sdkconfig.c3.local -p /dev/cu.YOUR_BOARD flash
   ```

2. Install the app on a physical iPhone with your development team (the
   project does not pin one):

   ```sh
   xcodebuild build -project apps/ios/Pathnod.xcodeproj -scheme PathnodChallengeScan \
     -destination 'id=YOUR_IPHONE_UDID' -allowProvisioningUpdates DEVELOPMENT_TEAM=YOUR_TEAM
   xcrun devicectl device install app --device YOUR_IPHONE_UDID \
     path/to/Debug-iphoneos/PathnodChallengeScan.app
   ```

3. Quit the macOS simulator so the app cannot pick it instead of the board.
   Keep the iPhone near the ESP32, open **Pathnod S1**, tap **Start three
   challenges**, then **Copy results**. A session takes about five seconds
   because of the two pacing waits.
4. Optionally record the serial log: each accepted challenge prints
   `Challenge processing + notification enqueue: N us`.

## Results (2026-10-04)

| | |
| --- | --- |
| Board | ESP32-C3 (QFN32) rev v0.4, 4 MB embedded flash, 160 MHz |
| Firmware | DEV-22 (`c5efb0e`), development profile, ESP-IDF v5.5.1 |
| iPhone | iPhone 16 Pro (`iPhone17,1`), iOS 27.0 (24A437) |
| Distance | Phone held next to the board, not measured |
| ATT MTU | 185 (every response arrived by notification; no read fallback) |
| INFO | capabilities `0x0000000a`, zero protocol hint, device ID prefix `2b52d036962219b5` |

| Session | Grace | Advertised ID | RTT 1 / 2 / 3 (ms) | Median (ms) | Counters |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 s | matches INFO | 60.0 / 58.8 / 57.3 | 58.8 | 193–195 |
| 2 | 1 s | matches INFO | 52.9 / 52.2 / 46.7 | 52.2 | 196–198 |
| 3 | 1 s | matches INFO | 52.6 / 58.3 / 38.3 | 52.6 | 199–201 |
| 4 | 1 s | matches INFO | 53.2 / 58.5 / 38.9 | 53.2 | 202–204 |
| 5 | 1 s | **not advertised** | 52.9 / 59.2 / 39.0 | 52.9 | 205–207 |
| 6 | 3 s | matches INFO | 51.2 / 37.7 / 68.0 | 51.2 | 208–210 |
| 7 | 3 s | matches INFO | 52.6 / 59.8 / 41.5 | 52.6 | 211–213 |
| 8 | 3 s | matches INFO | 80.2 / 58.2 / 38.6 | 58.2 | 214–216 |

- **All 8 sessions passed**: 24 signatures verified on the iPhone, no rate-limit
  rejection, counters strictly increasing across sessions.
- **Median notification RTT per session: 51.2–58.8 ms** (median of medians
  52.75 ms). Over the 24 exchanges: median 52.9 ms, minimum 37.7 ms,
  maximum 80.2 ms. Acceptance (< 150 ms) is met with margin.
- **Firmware processing** (signature + notification enqueue, serial log):
  21.5 ms for the first challenge after boot, which includes the NVS counter
  reservation, and 15.4–15.5 ms for the 23 others. None reached the 50 ms
  warning. The gap between writes seen by the board was 2.23–2.39 s for 15 of
  the 16 paced writes, and 3.88 s once (session 6, challenge 2); a longer gap
  only delays the session.
- Session 5 did not see the Service Data within 1 s, so the identity check was
  skipped. The grace was raised to 3 s and all three following sessions
  matched.

Regression against the macOS simulator (`--delay-ms 0`, ESP32 unplugged):
three verified responses, median 54.1 ms (54.1 / 55.2 / 44.6), capabilities
`0x00000000`, Service Data "not advertised", ATT MTU 515.

## Limits

- One board, one iPhone, foreground only, at close range. The S1 background
  discovery measurement and its fallback are recorded in the Gate 1 decision
  (DEV-17); DEV-23 does not change them.
- The RTT runs from just before the write with response to the notification.
  It includes BLE scheduling and is not a distance measurement; the policy
  threshold remains `rtt ≤ 400 ms` (Spec §4.4).
- The epoch and observation hint are zero in this development test.
- The read fallback was not exercised (MTU 185). It remains covered by the
  DEV-10 logic and the DEV-21 MTU 23 procedure.
- DEV-22's open items are unchanged by this test: binary size above 200 KB,
  NVS power-interruption recovery and battery behavior.
