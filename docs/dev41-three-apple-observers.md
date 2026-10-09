# DEV-41 — three physical Apple observers

DEV-41 implements roadmap A3.9. Its DEV-48/BIZ-48 label was a numbering error.
The hardware used is **two iPhones and one iPad**, with three separate local
credentials and App Attest keys. An iPad replaces the unavailable third iPhone;
the record does not claim three iPhones or three unique people.

## Provisioning and enrollment

Use the production Mopro submission project:
`apps/ios/MoproObservation/submission-project.yml`. It targets device families
`1,2` and iOS/iPadOS 18 or later. The app's enrollment, observation and withdrawal
copy refers to the current device. Existing bundled Mopro bindings and the
matching trusted circuit are required; the ordinary S1 build is not a mobile
proof build.

1. Connect each device to the Mac, unlock it and accept the trust prompt. In
   Xcode 27, open **Xcode → Open Developer Tool → Device Hub**. Enable Developer
   Mode under **Settings → Privacy & Security**, restart and confirm activation.
2. Build with the same registered App ID, developer team and App Attest
   environment as the verifier. Automatic signing can register the additional
   devices with `-allowProvisioningUpdates -allowProvisioningDeviceRegistration`.
   Install the signed application. Preserve any existing valid installation,
   Keychain credential and attestation key.
3. Keep the enrollment database, keys, generated Xcode project, bindings, proving
   files and device metadata outside Git. Run the production verifier against
   the intended deployment; use no simulator, fixture enrollment or receipt sink.
4. On each new device, choose **Enroll observer → Prepare observer commitment**,
   enter the service URL and choose **Enroll this device**. On a local development
   network, the Mac and devices must share Wi-Fi; accept local-network access.
5. Require a successful class-1 response with 20 siblings. Verify separate
   commitments/leaf indices in the enrollment store and wait until the latest
   root is confirmed and active on devnet. A model number or `isSupported` result
   alone does not establish successful enrollment.

### iOS 26 compatibility

Apple added the signed launch-category and bundle-version extensions with
[iOS 27](https://developer.apple.com/videos/play/wwdc2026/201/). The iPhone 13 on
iOS 26 initially failed with `invalid_environment.bundle_version`, although its
installed build version was `1`, because its authentic legacy object has no
extensions.

The verifier now accepts that format after the existing Apple certificate chain,
nonce, key, App ID, environment and counter checks. Assertions still require the
enrolled key's signature, expected payload hash and an increasing counter. Missing
version/category remain unknown; a client-reported OS version never authorizes
the format. An object carrying extensions must still meet the configured version
policy. Once signed version/category fields appear for a key, the gate,
observation and withdrawal paths preserve them with the counter and reject
their disappearance or a changed category, including after a server restart.

Only the previously rejected, unenrolled iPhone 13 key was reset after the fix.
Its observer secret/commitment stayed unchanged. Neither the original iPhone's
valid identity nor the iPad's successful enrollment was reset.

## Physical procedure

Power the registered ESP32 and keep it near the observers. A 5 V USB adapter can
power it independently of the Mac. Close other BLE clients and operate one
observer at a time. The Mac hosts the verifier; the phones/tablet perform the
actual BLE exchanges, Apple assertions and bundled Mopro proofs.

On each new observer:

1. Open **Observe a device**, review the privacy information and choose
   **Observe nearby device**. Location, motion and unpaid observations were
   disabled for this run.
2. Require three verified device signatures, acceptable median RTT and at least
   five RSSI samples. Check that the registered device and epoch are the intended
   ones; an available-slot quote is not confirmation of a paid observation.
3. Agree to send and choose **Prove and queue observation**. Then use
   **Refresh chain confirmation** until the commitment is finalized and the
   allocation flag and epoch counters are visible.
4. Repeat the submission button for the same saved capture. It must report an
   already-validated observation and leave the raw count, paid slots and rewards
   unchanged. Do not collect a replacement session for this check.

The iPhone 16 Pro's already-finalized DEV-38 capture was reused in the same epoch.
The iPhone 13 and iPad collected new physical sessions on 2026-10-09. Preserving
that earlier observation avoids manufacturing a new credential on the original
phone.

## Public devnet evidence

The [public account snapshot](evidence/dev41-three-apple-observers.json) records
the three commitment bindings, successful transaction provenance, allocations
and the final audit slot. It contains no private enrollment or transcript data.

Program: `HC6YfYPZSTVE37PF6qcdgAyRp2XSSyPovXGjpu9BiuVa`.

Protocol: `7e05517d5dc3c3893a9052e7587c52ef5838b7597a73c7b5ba309e53f5cef84e`.

ESP32-C3 device: `2b52d036962219b5195412a33950044c747666eac5d9e88ddfa39dc613b049b8`.

Epoch: **2962** (604,800 seconds). Each observation has class 1, three verified
device signatures, six RSSI samples, and a distinct nullifier/pseudonym.

| Physical observer | Session | Median RTT | Finalized transaction |
| --- | --- | --- | --- |
| iPhone 16 Pro, iOS 27 | Existing DEV-38 capture, 2026-10-08 | 48 ms | [Original observation](https://explorer.solana.com/tx/3pdncWBm32MeE7WbWT47xATUggYVztNcYeyBdRnGbEQKFf3PyTkkShaZJJpCgk7PgGbQUCy1hDXantUt1sjox8NB?cluster=devnet) |
| iPhone 13, iOS 26.0 | New physical capture, 2026-10-09 | 60 ms | [Second observation](https://explorer.solana.com/tx/4bXkDTdbkvgEQrtKK6ahLg9MVsM9Hr8iAojcaNu7U8LXadCM15jiR1Ja1CV4GbRrh5RTJuqmVNMEkSJGfsLYErpa?cluster=devnet) |
| iPad Air 13-inch M2, iPadOS 27.0.1 | New physical capture, 2026-10-09 | 53 ms | [Third observation](https://explorer.solana.com/tx/61rbWEb7HzWdNpwNb1e9VFVGZsi8U7JxCNU84XasK6M9vvr3WNCQ2XsoegK7Bi2wiUDLkEJyHudeEmGhk25MZ9iZ?cluster=devnet) |

The enrollment tree contains three distinct commitments and three class-1
leaves. [Revision 3 publication](https://explorer.solana.com/tx/3pAUVaz5Yi8qzPPKahBNEhhHr1XNFZrbB8CwK9d5NrHCd8sdVizLf2w3zprdREj35kUFGTSTNFRqZ9XsELFjv2EB?cluster=devnet)
confirmed the active root
`05a3eca62f9985b513ced926a5302053c6ce3c375c389904ffecf8911ab99cf8`
with `leaf_count = 3`.

The chain audit revalidated the requester-encrypted transcripts against the
finalized commitment PDAs and registry, including all nine device signatures.
It reconstructed the depth-16 native observation root independently from the
three transcript hashes, with domain-separated SHA-256 leaves, empty nodes and
internal nodes. The result matches DeviceEpoch:

`6c4d939abcd3678df132ae71d3922fbcdc81be7b9eac22700e1bd4cc634c77c9`.

The audit checked official devnet genesis, successful finalized transaction
statuses, program account owners, scoped payout bindings and token-account
mint/authority bindings. The iPad's local relay status had no signature after
account-based reconciliation. Its transaction above was recovered from the
commitment account's finalized history, rather than treating an absent or failed
local signature as the account's provenance.

| Finalized accounting | Amount |
| --- | --- |
| Raw independent observers | 3 |
| Paid slots used | 3 |
| Gross reward per observer | 0.05 devnet USDC |
| Fee per observer | 0.01 devnet USDC |
| Available payout per observer | 0.04 devnet USDC |
| Total available payouts | 0.12 devnet USDC |
| Fee vault | 0.03 devnet USDC |
| Remaining protocol escrow | 0 |
| Withdrawn amounts / payout nonces | 0 / 0 on all three payouts |

The operator repeated the iPad's submission button and confirmed the
already-validated message with counters still at three. A subsequent finalized
audit found exactly the same three commitments and reward allocations. This
exercises the app's saved-receipt guard; it is not a new raw HTTP replay or a new
on-chain duplicate transaction. DEV-38's separate finalized E_NULLIFIER rejection
remains documented in its [Gate 2 record](dev38-physical-gate2.md).

The additional observations cleared the previous DEV-39 confidence hash
`225f8a755b09c3354ae795f7e4c0b76a6e1719e3163001c83c98f5e036d37e1e`
to zero. No new confidence report was published. Three raw credentials do not
override the conservative co-occurrence policy or establish three unique people;
the shared single-device histories produce one merged witness group and a LOW
computed preview under the current policy.

## Checks and limits

- Signed Mopro builds succeeded for the iPhone 13 and iPad; the universal app
  installed and launched on both physical devices and completed real enrollment,
  BLE capture, proof, server validation and finalized devnet allocation.
- Verifier typecheck/build and 124 verifier tests passed (two existing skips).
  Regression tests cover legacy assertions, stripping signed extensions,
  signature/challenge tampering, replay, authorized upgrades, downgrade rejection
  and persistence of the new signed metadata across a server restart.
- Swift tests passed: 53 XCTest tests and 103 Swift Testing tests.

The public evidence records hashes, chain addresses, transactions and aggregated
results only. App Attest IDs, observer secrets, raw envelopes/transcripts,
private databases, provisioning metadata, proving files and recordings remain
outside Git. Public transaction evidence does not identify physical hardware by
itself; the model/session provenance comes from the user's operation of the
connected physical devices and the original DEV-38 record.

This run validates foreground observation and payment allocation. It does not
exercise three new withdrawals, background discovery, unique-human independence,
location confidence or the still-open DEV-22 quota/power-cut tests. Firmware was
unchanged; the known inter-challenge rate-limit waits still prevent this run from
establishing the spec's <5-second collection target.
