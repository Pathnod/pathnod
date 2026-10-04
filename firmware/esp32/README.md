# ESP32 BLE identity and hardened challenge/response (DEV-20 / DEV-21 / DEV-22)

ESP-IDF **v5.5.1** (`fcae32885b0296b32044cb99ecbdc50d98dddb83`),
NimBLE peripheral, ESP32-C3 / ESP32-S3, 4 MB flash assumed.
The managed libsodium component is pinned in `main/idf_component.yml`.
Confirm the board's chip, flash size and serial port before flashing.

This implements discovery, persistent Ed25519 identity, GATT signing and DEV-22
replay/rate protection with an NVS-backed monotonic counter.
No trusted clock, secure element, non-exportable signing key, or relay resistance
is claimed. INFO capabilities are **0x0000000a** (bits 1 and 3), in both profiles:
flash/NVS encryption does not make a software Ed25519 key non-exportable.

## Build (development profile, no irreversible provisioning)

Install the official SDK outside the repository:

```sh
git clone --branch v5.5.1 --depth 1 --recursive --shallow-submodules \
  https://github.com/espressif/esp-idf.git /path/to/esp-idf
git -C /path/to/esp-idf rev-parse HEAD
# Must be fcae32885b0296b32044cb99ecbdc50d98dddb83.
/path/to/esp-idf/install.sh esp32c3,esp32s3
. /path/to/esp-idf/export.sh
cd firmware/esp32
idf.py -B build-c3 -D SDKCONFIG=sdkconfig.c3.local \
  -D SDKCONFIG_DEFAULTS=sdkconfig.defaults set-target esp32c3
idf.py -B build-c3 -D SDKCONFIG=sdkconfig.c3.local build
```

For S3 use `esp32s3`, `build-s3` and `sdkconfig.s3.local`.
Use separate build directories/configurations; do not mix development and
protected builds. Target-specific `dependencies.esp32c3.lock` and
`dependencies.esp32s3.lock` are tracked; generated SDK configurations,
managed components and binary output are ignored.

Only after confirming the board and port, the operator may run:

```sh
idf.py -B build-c3 -D SDKCONFIG=sdkconfig.c3.local -p /dev/cu.YOUR_BOARD flash monitor
```

No automated test or CI job flashes a board or burns eFuses.
Development NVS is **plaintext**. Never register this identity as a production
device. Do not copy its NVS image, seed, dumps or key partitions into Git/logs.

## Identity lifecycle

On first successful initialization, after starting the BLE controller for
hardware entropy, libsodium generates a 32-byte Ed25519 seed on the device.
The seed is committed to NVS (`pathnod` / `ed25519_seed`) before advertising.
Subsequent boots derive the same public key from the persisted seed.

`device_id = SHA-256(ASCII("Pathnod/device/v0") || public_key)` (32 bytes).
The domain is 17 bytes, without a terminating NUL. The private key is not logged
or exposed by GATT. Temporary seed and secret-key buffers are wiped after use.
The internal signing key stays in RAM after successful initialization, avoiding
NVS reads/key derivation for each challenge; failed reinitialization clears it.
Only canonical challenge signing is exposed, not arbitrary-message signing or
a private-key export endpoint. All GATT callbacks run on the NimBLE host task.

Malformed storage, initialization errors, failed writes and failed commits stop
startup. There is deliberately **no automatic NVS erase or identity rotation**.
Manual flash erasure/factory reset loses the identity and requires a new device
registration. Switching an existing plaintext NVS to encrypted storage is not an
in-place migration: use a separately reviewed provisioning workflow and treat
any identity replacement explicitly.

## BLE discovery contract

Provisional service UUID: `534F5645-4C00-0000-0000-000000000001`.

| Packet | AD structure | Bytes |
| --- | --- | --- |
| Advertisement | Flags + complete 128-bit service UUID list | 21 |
| Scan response | 128-bit Service Data: UUID + `device_id[0..8]` | 26 |

The UUID is little-endian on the BLE wire. The ID prefix is the **first eight
bytes**, unchanged (no integer conversion). Both packets fit the legacy 31-byte
limit; putting both structures in one packet would exceed it. Advertising is
connectable at a configured 1000 ms interval (BLE adds its standard jitter).
There is no advertised local name; discover by service UUID. The GAP device
name is `Pathnod` after connecting. Advertising restarts on disconnect, failed
connection and host re-synchronization.

Service Data requires an active scan response and may not be surfaced in every
iOS/background scanning mode. UUID discovery is the baseline acceptance
criterion. Do not claim background discovery or early prefix filtering has been
validated until it is measured on an iPhone.

INFO UUID `…0002`, Read: `version(1)=0 || curve(1)=1 || public_key(32) ||
capabilities(4, big-endian)=0x0000000a || protocol_hint(32)=0`, total 70 bytes. A full characteristic
read must return all 70 bytes; MTU 185 is preferred, long reads are available.

## GATT contract (DEV-21 transport, DEV-22 counter/guards)

- CHALLENGE UUID `…0003`: Write **with response**, exactly 44 bytes:
  `nonce(32) || obs_epoch(4, big-endian) || obs_hint(8)`.
- RESPONSE UUID `…0004`: Read / Notify, 78 bytes:
  `signature(64) || dev_ts(8)=0 || dev_counter(4, big-endian)>0 || evidence_len(2)=0`.
- Signed payload: `Ed25519.sign(SHA-256(DEV_MSG_V0))`, not the raw message and
  not Ed25519ph. `DEV_MSG_V0` is the **20 ASCII bytes** `Pathnod/challenge/v0`
  (without NUL), followed by the entire 44-byte challenge, 8 zero timestamp
  bytes, the 4-byte big-endian response counter and a 32-byte zero evidence hash:
  **108 bytes**. There is no clock or evidence capability.
- Exactly one connection is supported. Response and subscription state are
  cleared on connect/disconnect/host reset, including reused connection handles.
  Reading before a successful challenge fails. Invalid challenge lengths clear
  any previous response and are rejected; no partial challenge is signed.
- At MTU >= 81 the notification carries the entire response (MTU 185 preferred).
  At MTU 23 it carries a 20-byte prefix; the central must then **read the full
  characteristic**, as the existing iOS read-fallback supports. ATT long writes
  are assembled/offset-validated by NimBLE; do not send separate partial writes.
  Without a notification subscription, the full response is still readable.
  Notification enqueue failures return an ATT resource error; reading remains
  possible, but the central must not treat the failed write as successful.
- Serial logs measure signature processing plus notification enqueue in
  microseconds and warn at >= 50,000 us. This is not end-to-end radio RTT or proof
  of delivery. A fresh nonce and rate-limit-compliant challenge are required.

### Hardware acceptance — @kazai777

1. Build/flash the correct development profile using the instructions above.
   Read INFO and check that its public key is unchanged from DEV-20.
2. Subscribe to RESPONSE, preferably negotiate MTU 185, then write a fresh
   44-byte challenge to CHALLENGE **with response**. Capture the full 78-byte
   response; timestamp/evidence length must be zero and counter nonzero.
   Wait at least two seconds between challenges, measured from the preceding write.
3. Independently verify the public key (32 bytes from INFO), challenge and response:

   ```sh
   node firmware/esp32/tests/verify_response.mjs PUBLIC_KEY_HEX CHALLENGE_HEX RESPONSE_HEX
   ```

   Use hex without spaces. Alter a nonce/epoch/hint byte: verification must fail.
4. Test MTU 23: use an ATT long write for the 44-byte challenge and a full read
   after the short notification. Send lengths 0, 43 and 45: they must fail; the
   old response must no longer be readable. Read before the first challenge,
   then disconnect/reconnect: neither case may return a prior session's response.
5. Send at least 100 fresh challenges spaced at least two seconds apart. Record chip, SDK, CPU frequency, iPhone/iOS,
   MTU, maximum processing time, notification delivery and central RTT separately.
   Every firmware processing log must be **< 50,000 us** to satisfy DEV-21.
  No real-board timing or BLE acceptance is claimed by the host tests.

Task: [DEV-21](https://app.notion.com/p/3e2bc83eb4a280b8a991f1ededb30c46).
Stack base: `feat/dev-20-esp32-ble-identity`; DEV-21 does not replace DEV-20's
pending hardware discovery/persistence checks.

## DEV-22 anti-abuse and counter contract

### Replay and rate limits

- A boot-scoped, bounded **300-entry LRU cache** stores exact 32-byte nonces,
  admission time and last-use time. Expiry is exactly ten minutes after admission;
  replay touches update LRU order but do not extend expiry. Epoch/hint changes do
  not make a repeated nonce fresh.
- Valid-length attempts are limited to **one per two seconds per connection** and
  **30 per rolling 60 seconds globally**. Global quota and nonce cache survive
  disconnect/reconnect and BLE host resets. Only the per-connection quota resets.
  Replays and signing/persistence failures consume the attempt quota. Malformed
  lengths are rejected before signing and consume no nonce/counter.
- A nonce is reserved before signing. Every rejection clears the current session
  response. No replay/rate rejection advances the counter or produces a signature.
- At the legal maximum of 30/minute, at most 300 insertions remain live over ten
  minutes, so the normal guarded path need not evict a live nonce. LRU behavior is
  tested independently; a smaller cache would weaken the ten-minute guarantee.
- Cache/global quota are **RAM-only** and reset on reboot. Counter persistence
  prevents reuse of a previously emitted counter, not a nonce cache surviving
  power loss. A repeated nonce after reboot can yield a new signature/counter;
  old responses must still be rejected by verifier counter policy/nullifiers.
- `esp_timer_get_time()` supplies monotonic boot-relative microseconds; it is not
  a trusted Unix clock. Negative/backward time is rejected. INFO bit 0 stays unset.

### Durable monotonic counter

- The counter is internally allocated, nonzero, and signed into DEV_MSG_V0.
  Clients cannot choose its value. INFO bit 1 indicates this feature.
- NVS stores an upper reservation boundary in `pathnod/counter_v1`. Before using
  a new block, firmware commits a reservation of **64** values. At boot it starts
  strictly above the persisted boundary, skipping unused reserved values.
  Gaps are expected; counters must increase, not necessarily be consecutive.
- This reduces flash commits to one per 64 responses (plus boot-related skipped
  blocks), rather than committing every challenge. The first response after boot
  and each block boundary include NVS latency in the existing processing metric.
  Those boundaries must also satisfy the pending hardware < 50 ms test.
- Existing DEV-20/21 identities migrate without changing their seed/public key
  when neither counter field exists. The first reservation also persists
  `counter_mode=1`. A missing counter after that marker exists, wrong NVS type,
  read/open/write/commit error or exhausted 32-bit range fails closed; no automatic
  reset is performed. A failed reservation disables signing until reinitialization.
  If a boundary exists without its marker after a partial write, it is treated as
  reserved (not reset); the next successful reservation persists the marker.
- NVS snapshots restored to older values, deleting both counter fields, malicious
  firmware and flash erasure are **not hardware rollback protected**. Never erase
  or restore NVS while retaining the registered identity; production anti-rollback
  needs a separate provisioning design. Encryption alone does not provide it.
- Capability bits **1** (counter) and **3** (replay/rate guard) are set. Clock,
  evidence, secure-element and externally linked identity bits remain clear.
  Advertising is unchanged: configured **1600 BLE interval units = 1 Hz**, plus
  the standard BLE advertising jitter. This is not a battery-consumption claim.

### Hardware acceptance — @kazai777

1. Read INFO: capability bytes must be `00 00 00 0a`. Verify each response with
   the Node script, including its nonzero counter.
2. Send three different nonces, each at least two seconds apart. Signatures must
   verify and counters must increase. The existing DEV-10 ChallengeScan app sends
   challenges immediately; its pacing must be adapted for DEV-23, or use an ATT
   test client with controlled timing. Do not disable firmware limits for the demo.
3. Retry a nonce after two seconds, with changed epoch/hint, and after reconnect:
   all must fail while cached. Retry after ten minutes: it may succeed within quota.
4. Send a fresh challenge before two seconds: it must fail. Reconnect rapidly and
   attempt a 31st challenge within a rolling minute: it must fail. The same nonce
   may be retried once the rate limit expires if it was never admitted.
5. Save the last emitted counter, reboot without erasing flash, then send a fresh
   challenge. Its counter must be greater, while the public key stays unchanged.
   Repeat with power interruption near a reservation boundary on a test board.
6. Measure latency on the first response and across at least 65 accepted responses
   (two reservation blocks). Record maximum, board, clock, MTU and radio RTT.
   Host tests cannot verify real NVS crash recovery, radio timing or flash wear.

Task: [DEV-22](https://app.notion.com/p/3e2bc83eb4a280d287eae2bad8d1fd57),
[GitHub issue #43](https://github.com/Pathnod/pathnod/issues/43).
Stack base: `feat/dev-21-esp32-gatt-challenge-response`.

### Size budget

The SDK configuration selects `CONFIG_COMPILER_OPTIMIZATION_SIZE=y` without
disabling storage protection or protocol features. Size means the **uncompressed
application `pathnod_device.bin`**, excluding bootloader, partition table and NVS;
the acceptance threshold is strictly **< 200,000 bytes**. `idf.py size` also reports
ELF archive contributions, but is not a substitute for actual binary size.
CI reports binary bytes and warns when this target is exceeded. It intentionally
keeps functional/build checks useful: **green build checks do not establish the
DEV-22 size acceptance criterion**. The budget remains unresolved.

The build now selects ESP-IDF's minimal component dependency closure and nano
printf/scanf. Protocol fields, Ed25519, NVS encryption and BLE security are
unchanged. Nano formatting has no 64-bit integer support: processing-time logs
use a saturated 32-bit diagnostic value, not a change to signed counters.
CI includes `size-components` in its summary and generates `size-files` to
identify the actual contributors before further optimization.

Compile-only measurements on 2026-10-04 with ESP-IDF v5.5.1:

| Target | Development | Protected |
| --- | ---: | ---: |
| ESP32-C3 | 591,216 bytes | 594,400 bytes |
| ESP32-S3 | 565,120 bytes | 568,064 bytes |

All four builds pass, with unchanged dependency locks and protected-profile
NVS/flash checks. Both host profiles pass normally and with AddressSanitizer /
UndefinedBehaviorSanitizer. These images **still exceed 200,000 bytes**.
Bluetooth controller/host and libsodium remain major linked contributors;
do not strip cryptographic initialization or storage guards to claim compliance.
Recheck hardware processing time and BLE behavior after these build changes.

### Reproduce the global quota on hardware

Use a development test board, reset it once before starting, and close other
BLE clients. Do not reset the board during the trial: its quota is RAM-only.
On a BLE-capable computer, install `bleak` in a disposable Python virtual
environment and run (Python 3.10+, Node.js required):

```sh
python3 -m venv /tmp/pathnod-ble-quota-venv
/tmp/pathnod-ble-quota-venv/bin/pip install bleak==1.1.1
/tmp/pathnod-ble-quota-venv/bin/python firmware/esp32/tests/hardware_quota.py DEVICE_ADDRESS
```

On macOS, use the device's CoreBluetooth UUID, not its MAC address. The script
reconnects for each fresh challenge to bypass the per-connection pacing limit,
verifies the first 30 signatures and increasing counters, and records each
attempt's monotonic elapsed time. The 31st attempt must be inside the original
60-second window and rejected. It then checks recovery after window expiry
without a skipped counter. Slow reconnects produce **inconclusive** (exit 2),
not a pass. Capture the printed ATT error and correlate it with board logs:
a transport failure alone is not proof of quota enforcement. This test has
not been run on hardware by the implementation agent.

### Reservation interruption validation

Host tests cover old/new persisted ceilings at the 64-to-128 reservation,
a persisted ceiling without its migration marker, and a marker with missing
ceiling. The last case must fail closed; valid cases must preserve identity
and emit 65 or 129, never a previously emitted value. These are simulated
storage snapshots, not proof of actual flash power-loss behavior.

On a disposable board, independently verify and record counters up to 64,
interrupt power while attempting the next reservation, then reconnect and
verify the first new signature and unchanged public key. Repeat around initial
migration and subsequent reservation boundaries, without erasing NVS. Every
counter observed before a cut must remain below the first one observed after
recovery, or the device must refuse signing. Record board, firmware build,
serial logs and when power was cut; a routine power cycle alone is insufficient.

## Protected storage profile — operator review required

Flash encryption alone does **not** encrypt NVS values. The protected profile
requires both flash encryption and XTS-encrypted NVS; NVS keys live in an
encrypted `nvs_keys` partition, protected by the eFuse-backed flash key.
See [Espressif NVS encryption](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32c3/api-reference/storage/nvs_encryption.html)
and [flash encryption](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32c3/security/flash-encryption.html).

Build-only verification:

```sh
idf.py -B build-c3-protected -D SDKCONFIG=sdkconfig.c3.protected.local \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.protected' set-target esp32c3
idf.py -B build-c3-protected -D SDKCONFIG=sdkconfig.c3.protected.local build
```

`CONFIG_SECURE_FLASH_REQUIRE_ALREADY_ENABLED=y` makes the supplied bootloader
refuse an unprovisioned, unencrypted device rather than automatically encrypting
it on first boot. The application also checks flash encryption before touching
the identity. Do not remove that guard just to make a development board boot.
ESP-IDF exposes this guard only in its **development encryption mode**, so this
profile intentionally is not a release-mode production provisioning recipe.

Before deploying this profile, the operator must review the exact board's
eFuse state, secure-boot/flash-encryption workflow, recovery restrictions and
encrypted flashing procedure against Espressif's documentation. Programming
eFuses is irreversible and is **not performed by this repository**. A protected
firmware image is not proof the hardware has been securely provisioned. Secure
boot and protection against malicious replacement firmware require a separate
review; encryption alone does not provide them.

## Tests without hardware

Requires CMake, a C compiler and host libsodium (`brew install libsodium` on macOS
or `libsodium-dev` on Ubuntu).

```sh
cmake -S firmware/esp32/tests -B /tmp/pathnod-firmware-tests \
  -DCMAKE_PREFIX_PATH=/opt/homebrew/opt/libsodium
cmake --build /tmp/pathnod-firmware-tests
ctest --test-dir /tmp/pathnod-firmware-tests --output-on-failure
```

Tests compile the actual identity and advertising implementations, using an
in-memory NVS test double and real libsodium. They cover identity reuse,
Ed25519 public-key derivation, domain-separated ID hashing, malformed storage,
read/open/write/commit errors, protected-profile refusal on unencrypted hardware,
and exact advertising structures. They do not validate actual NVS power-loss
recovery, BLE radio behavior or eFuse provisioning.

DEV-21 adds a deterministic Node.js/OpenSSL interoperability signature vector,
digest-vs-raw-message verification, mutations across every signed field, malformed
challenge lengths, failed-init signing refusal and connection-state isolation.
These tests use the real session/signing code, but not NimBLE or the BLE radio.

## iPhone acceptance test (required to close DEV-20)

1. Flash the development profile to a confirmed C3/S3 board; open its monitor.
   Confirm the explicit development-storage warning and advertising log.
2. In nRF Connect on iPhone, scan for the provisional service UUID. The device
   need not be named in the advertising list.
3. Inspect its 128-bit Service Data: eight ID-prefix bytes following the UUID.
4. Connect, discover the service and read INFO. Check the 70-byte length,
   version/curve, public key, capabilities `00 00 00 0a` and zero protocol hint.
5. Independently compute SHA-256 of the 17 ASCII domain bytes followed by the
   32-byte INFO public key. Compare its first eight bytes to Service Data.
6. Reboot/power-cycle without erasing flash. Repeat: public key and ID prefix
   must be unchanged. Disconnect/reconnect and confirm advertising resumes.
7. Record board model, SDK revision, iPhone/iOS version and discovery results.
   Protected storage must additionally be validated on deliberately provisioned
   hardware; host tests alone cannot satisfy that requirement.

Task: [DEV-20](https://app.notion.com/p/3e2bc83eb4a280e39407fbf31511def2).
Protocol: [Pathnod Spec §1, §2.1, §2.4, §2.6](https://app.notion.com/p/Pathnod-Spec-638bc83eb4a28246abb3019bf8afa88d).

## DEV-20 baseline validation record (2026-10-03)

- Host development/protected tests pass with AppleClang, including AddressSanitizer
  and UndefinedBehaviorSanitizer runs.
- ESP-IDF v5.5.1 development builds pass on C3 and S3 in isolated temporary copies.
  Application binary sizes: C3 661,904 bytes; S3 643,440 bytes (bootloader and
  partition table excluded). The spec's **< 200 KB** size target is not met;
  measuring/revisiting this budget remains necessary for DEV-22.
- Protected C3/S3 builds also pass; their generated configurations retain flash
  encryption, NVS encryption, flash-backed NVS key protection and the
  already-enabled bootloader guard. This is compile/configuration verification,
  not a protected-hardware test.
- No board was flashed, no eFuse was programmed, and no radio/protected-hardware
  acceptance test was performed. DEV-20 cannot be marked fully validated until
  the iPhone discovery and identity persistence tests above pass on real hardware.

## DEV-21 validation record (2026-10-03)

- Development/protected host tests pass, including AddressSanitizer and
  UndefinedBehaviorSanitizer. The independent Node.js verifier accepts the
  deterministic public test vector.
- ESP-IDF v5.5.1 builds pass for C3 and S3, in both development and protected
  profiles. Application sizes: C3 681,712 bytes; S3 662,704 bytes; protected C3
  685,152 bytes; protected S3 665,872 bytes. The < 200 KB target remains unmet.
- No board was flashed and no eFuse was programmed. Real BLE reads/writes,
  notification delivery, MTU fallback and < 50 ms processing are **pending**
  the hardware acceptance procedure above; DEV-21 is not fully validated yet.

## DEV-22 validation record (2026-10-04)

- Host development/protected tests pass with real libsodium, including ASan/UBSan.
  Covered: counter-signed Node.js/OpenSSL vector, INFO bytes, exact rate boundaries,
  reconnect/global quota, replay/hint changes, fixed expiry, LRU eviction, full
  300-nonce window, storage failures (including ambiguous commit), marker corruption,
  reservation-boundary restart, zeroed rejected responses and 32-bit exhaustion.
- Four clean ESP-IDF v5.5.1 target/profile builds pass with size optimization.
  Protected configurations retain all encryption and already-enabled guards.
  Dependency lockfiles are unchanged. No board was flashed or eFuse programmed.
- Final application binaries: C3 development **617,200 bytes**, S3 development
  **600,688 bytes**, C3 protected **620,384 bytes**, S3 protected **603,632 bytes**.
  All are **above 200,000 bytes**; no compression or different size convention
  is used to claim compliance. Archive analysis identifies significant SDK/BLE,
  libsodium, libc and crypto contributions; simple size optimization is insufficient.
- **Open acceptance items:** < 200 KB binary budget, real NVS power-interruption
  recovery, BLE 1 Hz observation, radio/MTU behavior, < 50 ms including reservation
  writes, and battery behavior. DEV-22 must not be marked fully validated yet.
