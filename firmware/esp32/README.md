# ESP32 BLE identity baseline (DEV-20)

ESP-IDF **v5.5.1** (`fcae32885b0296b32044cb99ecbdc50d98dddb83`),
NimBLE peripheral, ESP32-C3 / ESP32-S3, 4 MB flash assumed.
The managed libsodium component is pinned in `main/idf_component.yml`.
Confirm the board's chip, flash size and serial port before flashing.

This implements discovery and persistent Ed25519 identity only. INFO is readable
for identity inspection; CHALLENGE/RESPONSE and signatures are DEV-21, while
nonce caching, rate limiting and a monotonic counter are DEV-22.
No trusted clock, secure element, non-exportable signing key, or relay resistance
is claimed. INFO capabilities are **zero**, even in the protected profile:
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
DEV-21 must preserve this identity when adding its internal signing API, without
exposing arbitrary-message signing or a private-key export endpoint.

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
capabilities(4)=0 || protocol_hint(32)=0`, total 70 bytes. A full characteristic
read must return all 70 bytes; MTU 185 is preferred, long reads are available.

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

## iPhone acceptance test (required to close DEV-20)

1. Flash the development profile to a confirmed C3/S3 board; open its monitor.
   Confirm the explicit development-storage warning and advertising log.
2. In nRF Connect on iPhone, scan for the provisional service UUID. The device
   need not be named in the advertising list.
3. Inspect its 128-bit Service Data: eight ID-prefix bytes following the UUID.
4. Connect, discover the service and read INFO. Check the 70-byte length,
   version/curve, public key and zero capabilities/protocol hint.
5. Independently compute SHA-256 of the 17 ASCII domain bytes followed by the
   32-byte INFO public key. Compare its first eight bytes to Service Data.
6. Reboot/power-cycle without erasing flash. Repeat: public key and ID prefix
   must be unchanged. Disconnect/reconnect and confirm advertising resumes.
7. Record board model, SDK revision, iPhone/iOS version and discovery results.
   Protected storage must additionally be validated on deliberately provisioned
   hardware; host tests alone cannot satisfy that requirement.

Task: [DEV-20](https://app.notion.com/p/3e2bc83eb4a280e39407fbf31511def2).
Protocol: [Pathnod Spec §1, §2.1, §2.4, §2.6](https://app.notion.com/p/Pathnod-Spec-638bc83eb4a28246abb3019bf8afa88d).

## Validation record (2026-10-03)

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
