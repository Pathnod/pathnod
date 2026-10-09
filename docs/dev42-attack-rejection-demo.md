# DEV-42 — visible attack rejection checks

DEV-42 implements roadmap A3.10 with a finalized nullifier replay and an
explicitly simulated latency test. It builds on DEV-41's physical Apple app and
keeps the existing enrolled identities and ESP32 firmware.

## Enable the demonstration

Build the production Mopro submission project in Debug with the matching
proving circuit, App Attest App ID/environment and development signing profile.
The additional **Attack rejection demo** navigation entry is compiled under
`DEBUG`; the Release app does not expose it. The ordinary S1 app build has no
mobile prover and cannot satisfy the latency demonstration.

Use the DEV-37 hardware deployment and its current production verifier, real
enrollment database, signer, funded relayer and observation lookup table. The
selected observer must already own a finalized, paid observation on that
deployment. A different key, revoked observer, unknown transcript or unconfirmed
receipt cannot authorize replay spending.

Enable the backend explicitly before starting the verifier:

```sh
mkdir -m 700 /absolute/private/attack-journals
export PATHNOD_ATTACK_DEMO_DIRECTORY=/absolute/private/attack-journals
```

The directory must be outside Git and have permissions 700. Journal files use
600. The server refuses this mode with `NODE_ENV=production`, without a configured
relayer/lookup table, or on a target other than official Solana devnet. It never
requests a faucet. Keep all existing environment variables for enrollment,
root publication, verifier signing, relay and confidence recording unchanged.

`GET /demo/attacks` reports availability. Without the explicit setting, replay
routes return `demo_disabled`. The app also requires **Enable attack tests on
this device** and a successful server-availability check.

## Replay last proof

1. On the physical observer, open **Attack rejection demo** and enable its test
   toggle. The selected service must be the service bound to its saved finalized
   observation.
2. Choose **Re-submit last proof**. The app requests a one-time challenge for
   that transcript and signs it with the same enrolled App Attest key. The server
   checks ownership/revocation and binds the challenge to the key and transcript.
3. The server retrieves the trusted, previously validated relay payload. It
   reuses the exact proof/public inputs and verifier authorization in a new v0
   transaction, with a fresh blockhash and the original configured fee payer.
   It saves signed bytes, signature, expiry and the accounting baseline before
   any broadcast. The test deliberately skips preflight so rejection is
   finalized on-chain; it spends a devnet transaction fee.
4. Choose **Refresh replay confirmation** until the app displays
   **Finalized on-chain rejection: E_NULLIFIER. Counters and rewards unchanged.**
   Open its actual rejected transaction link if desired.
5. Restart the server with the same database, target and private journal directory.
   Choose **Re-submit last proof** again and refresh. It must recover the same
   signature without preparing or broadcasting a replacement transaction.

The journal is keyed by the transcript hash. Repeated requests recover that
same transaction. Recovery checks finalized history before expiry, and can
retransmit identical bytes while still valid. An expired ambiguous outcome,
wrong error/instruction, unexpected success, tampered wire or changed accounting
is shown as needing inspection. It does not silently rebuild a transaction or
claim a successful rejection.

The status route verifies the saved signature/instructions and actual finalized
E_NULLIFIER / 6001 at submit instruction 2. It exposes public outcome fields only.
Signed wire, key IDs and the original envelope remain private. Before/after
snapshots bind the selected commitment and payout, native epoch count/root,
USDC escrow, fee vault and payout vault. DEV-38's original one-observer Gate 2
checks remain enforced by its wrapper; the shared accounting reader supports
the already-populated three-observer epoch.

## Simulated latency

1. Keep the ESP32 powered nearby and close the observer app on other devices.
2. In the same screen, choose **Collect fresh challenges**. This uses a separate
   in-memory cache, without replacing the normal saved observation or credential.
   It allows collection when paid slots are already exhausted. The three replies
   must pass normal device signature, counter and local capture validation.
3. Check **Measured BLE median RTT**, **Added simulated delay** and
   **Submitted test median RTT**. The test adds exactly 600 ms to each reported
   RTT after the genuine physical collection. It changes no signed device data,
   identity, epoch, pseudonym, nullifier or ZK public input.
4. Choose **Submit latency test**. The app generates a real bundled Mopro proof
   and a real App Attest assertion for the modified canonical transcript, then
   posts it to the ordinary production `/observations` policy endpoint.
5. Require HTTP 422 / `E_RTT`, displayed as
   **Verifier rejected simulated latency: E_RTT.** Any other response or network
   failure is reported as an unconfirmed/unexpected test result. A retry uses the
   same in-memory envelope/assertion and the same endpoint.

The normal capture cache still rejects median RTT above 400 ms. The simulation
helper first requires a valid genuine capture and its matching credential/path;
its output is a labelled test transcript, not an accepted local observation.
No validation threshold, firmware delay or server policy is altered.

This is reported-latency simulation, not an actual BLE/internet relay and not
distance bounding. The policy checks registered key, device signatures and
device counters before E_RTT; assertion/ZK/nullifier checks occur afterward.
The app generates genuine proof/assertion material, but the server rejects at
the RTT boundary before validating those later conditions. In this run, the
existing same-epoch nullifier was already used; rejection at E_RTT does not
establish that a delayed observation would otherwise be eligible.

## Physical validation — 2026-10-09

I used the real iPad Air 13-inch M2 on iPadOS 27.0.1 and the same physical ESP32-C3
as DEV-41. The existing credential and App Attest key were preserved. The signed
Mopro app was installed and launched on the iPad; no simulator, receipt sink or
fixture enrollment was used for the physical run.

The original observation was
`d8cfafac003c38838440f0ce58de2b4156ba2769d31fa8deb3fce3ff120a9106`, on program
`HC6YfYPZSTVE37PF6qcdgAyRp2XSSyPovXGjpu9BiuVa`, protocol
`7e05517d5dc3c3893a9052e7587c52ef5838b7597a73c7b5ba309e53f5cef84e`, device
`2b52d036962219b5195412a33950044c747666eac5d9e88ddfa39dc613b049b8`, epoch 2962.

- [Replay finalized with E_NULLIFIER / 6001](https://explorer.solana.com/tx/3APmiSbbAHe5YxodqvfVVVtXncQumKCmU7CNfT5V3aLqea3xzaop1XycLGLFVFim84V7UCRm8SaJtSrCrxr33dp7?cluster=devnet),
  at submit instruction 2. The operator triggered the app button and confirmed
  its on-screen result. The server independently checked the finalized status
  and matching before/after accounting.
- A new physical collection showed **59 ms measured BLE median RTT** and
  **659 ms submitted test median RTT**. The operator confirmed E_RTT in the app
  after the actual mobile proof/assertion and HTTP submission. No accepted
  observation or reward was created by that test.
- After a real server restart, the operator repeated the replay button and
  confirmed the same finalized rejection and transaction link. The recovered
  backend status used the same signature and preserved the signed journal.

A separate finalized chain audit after both tests checked all three DEV-41
commitments, scoped payouts, token authorities/mints and native tree. Compared
with the pre-test state, raw observers and paid slots stayed at **3**, the root
stayed at `6c4d939abcd3678df132ae71d3922fbcdc81be7b9eac22700e1bd4cc634c77c9`,
and the confidence commitment stayed zero. Each payout still had gross 0.05,
fees 0.01, available 0.04 and withdrawn 0 devnet USDC, with payout nonce 0.
Escrow stayed zero and the fee vault stayed at 0.03 devnet USDC. The transaction
fee paid in SOL is separate from these unchanged USDC allocations.

The [public evidence summary](evidence/dev42-attack-rejection.json) contains the
rejection signature, public accounting and observed timing fields only. Full
envelopes, assertions, private databases, keys, signed journals, proving files
and captures are kept outside Git.

Both outcomes are readable in the app and suitable for a QuickTime capture of
the physical iPad screen. No new movie was required or recorded for this run.
A later recording can show the recovered E_NULLIFIER link and repeat a fresh
latency collection without reenrolling an observer or changing firmware.

## Automated checks

- Verifier typecheck/build and **133 passing verifier tests**, two existing skips.
- **157 passing Swift tests**: 54 XCTest and 103 Swift Testing.
- Signed production Mopro iPad build and unsigned standard iOS app build.
- New replay tests exercise actual signed v0 serialization and private journals
  with injected RPC responses: loss after broadcast, recovery after restart,
  expired ambiguity, unexpected success, changed accounting, tampered signed
  bytes, revoked/foreign owners, one-time challenges and disabled/default HTTP
  routes. They are infrastructure tests, separate from the physical evidence.
- The latency regression verifies unchanged signed device data and witness
  public inputs, changed RTT only, canonical serialization and rejection of a
  mismatched credential.

The task does not claim a real relay rejection, three new withdrawals, unique
humans, location confidence, background discovery or the open DEV-22 quota and
power-cut checks. The original session-duration target remains unmet with the
unchanged firmware's inter-challenge waits.
