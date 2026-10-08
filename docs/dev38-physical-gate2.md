# DEV-38 — physical Gate 2

Gate 2 records one real iPhone, one physical ESP32, one finalized observation on
Solana devnet and a rejected duplicate. The internal recording shows the actual
iPhone screen, captured over USB from QuickTime. Fixtures and simulator recordings
do not satisfy this gate.

## Prerequisites

1. Complete the DEV-37 hardware bootstrap using the full device INFO and verified
   enrollment input. Use its corrected, deployment-specific runtime database.
   An enrollment database bound to another deployment must not be fixed by blindly
   changing its target markers.
2. Start the production verifier with the generated environment, actual Apple app
   ID/environment and the real enrollment database. Enable the signer, relayer fee
   payer and observation lookup table. The fee payer must have devnet SOL.
3. Install the actual Mopro iPhone build with the matching trusted circuit/zkey.
   Enroll that installation, and wait for its root to be published. Set the correct
   service URL in the phone. Keep the phone unlocked and in the foreground.
4. Close other BLE clients, connect the ESP32 and verify its registration key/ID.
   Pre-approve Bluetooth/local-network permissions before recording; prompts may
   interrupt foreground capture. GPS and motion can remain disabled.

Keep the configuration, state, enrollment database, signing keys, proving files
and actual envelopes outside Git. Use a private directory (700) and private
configuration file (600). The CLI accepts official devnet only; it never requests
a faucet or falls back to a local validator.

```json
{
  "version": 1,
  "bootstrapReport": "/absolute/private/demo/report.json",
  "verifierConfig": "/absolute/private/demo/verifier-config.json",
  "stateDirectory": "/absolute/private/gate2",
  "video": "/absolute/private/recordings/gate2.mov"
}
```

`transcriptHash` is optional when exactly one matching observation exists in the
runtime database. Set it explicitly to select a session if several exist. A
hardware-mode report is required; fixture-mode bootstrap output is rejected.

```sh
make gate2-check GATE2_CONFIG=/absolute/private/gate2.json
```

The check validates the runtime target binding, cluster and circuit metadata.
It sends no transactions. This implementation includes the merged DEV-36 and
DEV-37 corrections. For an existing hardware bootstrap, run
`make demo-import-enrollment DEMO_CONFIG=/absolute/private/demo.json`, then
`make demo DEMO_CONFIG=/absolute/private/demo.json` to create the deployment's
runtime database and regenerate its configuration. The importer preserves the
source database and refuses to overwrite an existing runtime database.

## Raw recording

In QuickTime, choose **File → New Movie Recording**, then select the USB iPhone
under the capture-device menu. Verify the preview is the real phone screen, and
select the intended audio source; do not record the Mac webcam by accident.
Use a separate, private recording directory. No screenshot or movie is committed
or published automatically.

Start recording after the prerequisites pass. Keep the following sequence in a
single raw take:

1. Open **Observe a device**, review the privacy controls, then observe the nearby
   ESP32. Show its actual identity, three verified signatures, median RTT and RSSI.
2. Agree to send, then **Prove and queue observation**. A validated HTTP receipt
   confirms policy validation; it does not establish registration or payment.
3. **Refresh chain confirmation** until the phone shows a finalized devnet
   observation and its actual transaction link. Show the observer/paid-slot counts
   and reward-allocation flag. Inspect finalized gains in **Devnet gains**.
4. Run the duplicate command on the Mac while keeping the phone's confirmation
   screen visible:

   ```sh
   make gate2-status GATE2_CONFIG=/absolute/private/gate2.json
   make gate2-replay GATE2_CONFIG=/absolute/private/gate2.json
   ```

   The command reuses the exact proof/public inputs and verifier authorization,
   signs a new v0 transaction with a fresh blockhash and persists its signed bytes
   before broadcast. It deliberately skips preflight so the rejection is finalized
   on-chain. It spends a devnet transaction fee, and requires error **6001 /
   E_NULLIFIER** at the submit instruction. The counts, tree and reward accounting
   must remain unchanged. A simulation or a successful HTTP receipt retry alone
   does not establish this on-chain rejection.
5. Refresh the phone to show **Duplicate rejected on-chain: E_NULLIFIER** and its
   rejected transaction link. Stop and save the raw QuickTime recording.

For the optional payment extension of the take, show finalized gains and withdraw
the available test USDC using the DEV-36 flow. Fund the phone's withdrawal key and
prepare its correctly owned Circle devnet USDC destination account first. Verify
the actual destination balance; a broadcast response is not a finalized withdrawal.
Do this after the duplicate snapshot check so a legitimate withdrawal does not
change the balances while the anti-double-credit comparison runs.

## Recovery and evidence

The duplicate journal is private and preserves the signature, exact wire bytes,
last valid block height and accounting snapshots. A resume inspects history first
and retransmits identical bytes only while valid. A pending or expired ambiguous
outcome halts for inspection; it does not silently generate a replacement.
Check the PID in `run.lock` before removing a stale lock, and preserve the journal.

```sh
make gate2-report GATE2_CONFIG=/absolute/private/gate2.json
```

The report requires the confirmed original observation, a finalized nullifier
rejection with unchanged accounting, and a playable `.mov`/`.mp4` recording.
`ffprobe` must be installed. It records public chain evidence and the recording's
SHA-256, byte size and duration, with `internalOnly: true`; it does not embed the
movie, private paths, attestation IDs or actual envelopes. Human inspection must
confirm the raw take shows the intended physical sequence; a media container
check cannot prove what was filmed.

## Validation record

Gate 2 was completed on 2026-10-08 using an iPhone 16 Pro, the physical ESP32-C3,
Apple App Attest class 1 and the bundled mobile Mopro prover. The verifier used
the DEV-37 hardware bootstrap and its imported runtime enrollment database.
The recorded device ID is
`2b52d036962219b5195412a33950044c747666eac5d9e88ddfa39dc613b049b8`.

The raw take shows three verified device signatures, median RTT **48 ms**,
six RSSI samples, collection duration **7.725 s** and total discovery/collection
duration **8.679 s**. Location and motion were disabled. The current firmware's
rate-limit waits remain visible; this run does not establish the spec's <5 s
session target or the still-open DEV-22 quota/power-cut tests.

- [Original observation, finalized successfully](https://explorer.solana.com/tx/3pdncWBm32MeE7WbWT47xATUggYVztNcYeyBdRnGbEQKFf3PyTkkShaZJJpCgk7PgGbQUCy1hDXantUt1sjox8NB?cluster=devnet).
- [Duplicate, finalized with E_NULLIFIER / 6001 at submit instruction 2](https://explorer.solana.com/tx/5LdQte2GqvKUtTnrdsuVjF4PRmNsJvrsWRhB3aho1fe6prZMus5mrf2woqinRkqhEWuJTJmNhhTEFArwFLpvd3Cy?cluster=devnet).

The independent-observer and paid-slot counts stayed at **1**. The commitment
tree root stayed at
`b8c54532cf7f23c1772c1895e570a69417a91ce4f961c5c8a12639f327dd1e56`.
The gross reward was **0.05 devnet USDC**, fees **0.01**, available payout
**0.04**, remaining escrow **0.10** and withdrawn amount **0**. The duplicate
changed none of these account fields or token balances. Withdrawal was not
included in this Gate 2 take. Running the replay command again recovered the same
finalized failed transaction from the journal, without broadcasting a replacement
or adding another credit.

The internal recording is **166.641117 seconds**, **176,034,723 bytes**, with
a 1206 × 2622 video stream. Its SHA-256 is
`ac061e1c7f199ba58c87314d67f67e759eb8355f7ef8af858ad5f3cb45b63a00`.
Visual inspection confirmed the collection results, finalized observation and
on-screen duplicate rejection. The video, derived frames, full report, signed
wire journal and runtime database remain outside Git.

Automated validation: verifier typecheck/build, **81 passing verifier tests**
(two existing skips), **156 passing Swift tests** (53 XCTest and 103 Swift
Testing), and a signed build installed on the real iPhone. Account-binding tests
use fixtures; the physical run and recording above use the actual device,
Apple assertions, mobile proof and devnet transactions.

### Journal recovery coverage

The CLI and automated tests now use the same recovery function and atomic
journal writer. Eleven additional tests use real private journal files and
signed synthetic v0 transactions, with injected RPC responses for:

- A lost broadcast response, followed by restart with delayed history visibility
  and retransmission of the identical signed bytes while still valid.
- Restart with a processed/confirmed transaction, waiting for finality without
  rebroadcasting or replacing it because its blockhash has expired.
- An already-finalized E_NULLIFIER rejection, recovered before any expiry check
  and without rebroadcast, including another run from the rejected journal.
- Prepared/submitted transactions that are expired with an ambiguous outcome,
  preserving the journal and stopping before any send.

The tests also cover polling timeout, an unexpected success/error/instruction,
changed balances, an incomplete baseline and failure to persist before send.
Account comparison requires matching keys as well as values, so missing baseline
fields cannot bypass the unchanged-accounting check. These fault injections are
automated infrastructure tests, not additional physical sessions.

The updated verifier suite passes **92 tests** with the same two existing skips.
The refactored CLI also recovered the original finalized devnet rejection with
the same signature and unchanged accounting, without broadcasting a new
transaction. The original hardware recording and its checksum are unchanged.
