# Pathnod macOS BLE device simulator (DEV-09)

Development-only peripheral for the S1 challenge/response spike. It is not a physical-presence proof, production firmware, a secure element, or a relay-resistance test.

## Run

Requires a Bluetooth-capable Mac with macOS 13+ and Xcode/Swift 6. From the repository root:

```sh
swift test --package-path tools/device-sim
bash tools/device-sim/run-macos.sh --delay-ms 0
```

Do **not** use `swift run` or Xcode's Swift-package executable scheme for BLE testing. Those start a bare command-line binary without the required Bluetooth privacy usage string, and macOS can abort it with `TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION`. The launcher builds the executable, wraps it in a local ad-hoc-signed `.app` with `NSBluetoothAlwaysUsageDescription`, and opens it through macOS Launch Services. Launching the executable inside the bundle directly is not sufficient for TCC on this Mac. The generated app lives only under ignored `.build/`.

The app runs independently of the terminal. Open **Console.app** and filter for the `xyz.pathnod.device-sim` subsystem to view its state and challenge/response logs. Alternatively, run `/usr/bin/log stream --style compact --predicate 'subsystem == "xyz.pathnod.device-sim"'` in another terminal. Quit `pathnod-device-sim` in **Activity Monitor** after testing; Ctrl-C in the launching terminal does not stop a Launch Services app.

Use `--delay-ms 150` (or another integer from 0 to 10000) to simulate slower device processing for DEV-10 RTT measurements. Omit the option for zero added delay. The process reports Bluetooth state, advertising success/failure, challenge receipt, response emission and configured delay. It does not log keys, nonces or raw responses. Quit the old instance before relaunching with a different delay.

On first launch, macOS should ask for Bluetooth access for **PathnodDeviceSimulator**. Grant it; if denied, check **System Settings → Privacy & Security → Bluetooth**. Bluetooth must be enabled. The program prints a clear state/error if advertising cannot start. Use a separate BLE central, such as an iPhone running the future DEV-10 client, to perform the end-to-end test. An Apple Developer Program membership is not needed for this local ad-hoc-signed macOS app.

## GATT contract

The simulator advertises the **provisional** service UUID `534F5645-4C00-0000-0000-000000000001` from [Pathnod Spec §2.1–2.3](https://app.notion.com/p/Pathnod-Spec-638bc83eb4a28246abb3019bf8afa88d). It is not the final v1 UUID.

| Characteristic | UUID suffix | Operation | Encoding |
| --- | --- | --- | --- |
| `INFO` | `…0002` | Read | `version(1) ‖ curve(1) ‖ K_dev(32) ‖ capabilities(4) ‖ protocol_hint(32)` |
| `CHALLENGE` | `…0003` | Write with response | `nonce(32) ‖ obs_epoch(4, BE) ‖ obs_hint(8)` |
| `RESPONSE` | `…0004` | Read/Notify | `sig_dev(64) ‖ dev_ts(8, BE) ‖ dev_counter(4, BE) ‖ evidence_len(2, BE) ‖ evidence` |

`INFO` reports version `0`, curve `1` (Ed25519), zero capabilities, and a zero protocol hint. The key is generated at process start and never persisted. Zero capabilities are intentional: this simulator cannot promise a trusted clock, a persistent monotonic counter, rate limiting, secure-element storage, or service evidence. It still includes a simulated Unix timestamp and process-local counter in each response. `evidence_len` is zero.

The signature is Ed25519 over `SHA-256(DEV_MSG_V0)`, where `DEV_MSG_V0` is the ASCII domain literal `Pathnod/challenge/v0`, followed by the challenge's nonce, big-endian epoch, hint, big-endian timestamp, big-endian counter, and 32 zero evidence-hash bytes. The draft spec calls the domain literal “24 octets”, but the actual literal is **20 ASCII bytes**. This implementation follows the literal and tests its length; the annotation should be corrected in the spec before interoperability is finalized.

Malformed challenge lengths are rejected. A new valid challenge invalidates the previous response for that central, and a delayed response is emitted only if it still corresponds to the latest challenge. `RESPONSE` notifications target the subscribed central; reads return that central's latest completed response.

## macOS advertising limitation

`CBPeripheralManager.startAdvertising` on macOS supports local name and service UUIDs, **not arbitrary Service Data**. Therefore this simulator cannot advertise `device_id[0..8]` in Service Data as the full spec requires. A DEV-10 central should discover the advertised service UUID and read `INFO` for the public device key. ESP32 firmware in DEV-20 must implement the full Service Data advertisement. Do not treat successful discovery here as validation of the production advertising format.

## DEV-10 handoff

1. Scan for the provisional service UUID, connect and discover `INFO`, `CHALLENGE` and `RESPONSE`.
2. Read `INFO`; extract the 32-byte Ed25519 public key at offsets 2–33.
3. Subscribe to `RESPONSE`, then write exactly 44 bytes to `CHALLENGE` with response.
4. On notification, parse the 78-byte response, rebuild `DEV_MSG_V0`, SHA-256 it, and verify the signature using the `INFO` public key.
5. Repeat with at least two delays, for example 0 and 150 ms, and record measured RTTs. The configured delay is not a physical distance measurement.

Unit tests cover canonical encoding, malformed lengths, signing/verification, and response/challenge mismatch. The macOS radio, Bluetooth permission, notification delivery and RTT behavior require a real BLE central to validate.
