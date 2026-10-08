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
It sends no transactions. The DEV-36 and DEV-37 review corrections must be
integrated before final physical validation; this task does not silently migrate
their protected databases or replace a failed hardware step with fixtures.

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

Automated tests cover finalized-account binding, pending/payment separation,
untrusted owners, accounting changes and the required nullifier error. The
physical run and recording are recorded separately once completed. Gate 2 must
remain incomplete until the actual device run and raw internal video exist.
