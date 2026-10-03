# DEV-17 — Gate 1: S1 + S3 + S4

Decision date: 2026-10-03. Gate 1 determines whether construction can start
from the BLE challenge spike (S1), observation proof spike (S3), and minimal
on-chain submission spike (S4). App Attest (S2) is scheduled later and is not
a condition for this gate. This decision covers development feasibility, not
production security or a complete observation flow.

## Evidence

| Criterion | Result | Evidence and limit |
| --- | --- | --- |
| S1: three signed BLE challenges on an iPhone, median RTT < 150 ms | Pass for the foreground simulator test | [DEV-10 PR #13](https://github.com/Pathnod/pathnod/pull/13) reports three verified notification RTTs of 61.9, 59.3, and 59.9 ms with a 59.9 ms median at 0 ms simulated device delay. The 150 ms delay control produced a 210.9 ms median, so that case is outside the threshold as expected. This uses a macOS simulator and provisional UUIDs, not ESP32 hardware. |
| S1: five locked-screen trials and measured background discovery | Unverified against the quantitative gate | The project owner reports that the DEV-11 tests were run and worked, but no per-trial outcomes, discovery numerator/denominator, or background rate are currently available. The current challenge app stops an active session when it leaves the foreground and has no `bluetooth-central` background mode or restoration identifier ([controller](../../apps/ios/App/ChallengeScan/ChallengeBLEController.swift), [app test](../../apps/ios/App/ChallengeScanTests/ChallengeScanAppTests.swift)). Results from a different test build must be identified before claiming background discovery in this app. |
| S3: iPhone proof < 10 s and peak RAM < 500 MB | Pass for one device run | [DEV-14 PR #27](https://github.com/Pathnod/pathnod/pull/27) and the [iOS harness](../../apps/ios/MoproObservation/README.md) report a release-build proof on iPhone 16 Pro / iOS 27.0 in 0.122 s at 124.1 MB peak resident memory. This is one device run using a synthetic proof and a local setup. |
| S3: devnet Groth16 verification < 300,000 CU | Pass | [DEV-15 report](../dev15-solana-groth16.md) records 113,334 verifier CU and 117,251 total transaction CU with a 400,000-CU budget on devnet. The seven-input circuit and depth-20 Merkle path are retained. |
| S4: devnet submission and repeated nullifier rejection | Pass | [DEV-16 report](../dev16-observation-submit.md) links a confirmed submission and a second-payer replay rejected as `E_NULLIFIER` (6001). The valid transaction used 125,128 CU and 830 bytes with a 400,000-CU budget. Invalid proof, changed input, and mismatched nullifier all left their target PDAs absent. |

## Decision and fallbacks

**GO for construction with the S1 open-app fallback on 2026-10-03.** S3 and S4
satisfy their spike budgets. The foreground S1 challenge exchange verifies
three signatures and meets its RTT budget, and the owner reports that the
DEV-11 real-device tests worked. The tracked challenge app is foreground-only,
so this GO applies to an explicitly open-app observation path. It does not
mark background discovery green or claim a measured discovery rate.

The S1 fallback is an explicitly open-app demo. It is applied here because
the tracked challenge app stops its session outside the foreground. Background
discovery must be described as opportunistic, never as an invisible or
guaranteed tap. The roadmap also requires this fallback when a measured
discovery rate is below 20%. Until background behavior is implemented and
measured in the tracked app, the construction plan must not depend on it.

To expand the GO decision to background behavior, the DEV-11 tester
(`kazai777`) needs to recover the raw results or repeat the five locked-screen
trials. Record each outcome, the background-discovery numerator and
denominator, and the median RTT for the
signed challenge sequence, along with the device, OS, app build, simulator or
device firmware, and test duration. If the measured discovery rate is below
20%, retain the open-app fallback. No new DEV-11 issue is required for these
test results.

No S3 fallback is currently needed: the measured proof time, memory and
verification CU are below their limits, so the pseudonym and depth-20 Merkle
path remain in the circuit. S4 needs no duplicate-nullifier fallback. S2 remains
outside Gate 1 and must still be completed before claims based on real App
Attest can be made.

Gate 1 does not authorize production observations. DEV-16 still uses a
caller-selected test key and does not enforce protocol registry, root, epoch,
device signature, or attestation policy. Those checks belong to the later
integration tasks described in the [DEV-16 runbook](../dev16-observation-submit.md).
