# DEV-32 — observation proof, assertion and submission

DEV-32 connects a verified DEV-30 capture to the DEV-31 canonical transcript,
DEV-13/14 Groth16 prover and Spec §4.6/§5 submission envelope. It does **not**
implement DEV-33's acceptance policy, sign an accepted observation, submit a
Solana transaction or pay a reward.

## Client flow

In the ChallengeScan observation screen, review the additional submission
disclosure and enable **I agree to send this observation**. The verifier will
see the device responses, local signals (including optional geohash6), scoped
pseudonym, nullifier, proof and opaque App Attest key/assertion. It does not
receive the observer secret, precise coordinates or private Merkle witness.
This disclosure is separate from consent to collect a session locally.

The Mopro-enabled build:

1. Drains older pending envelopes for the selected endpoint before generating
   another Apple assertion. An unrelated endpoint does not block preparation.
2. Refreshes the authenticated DEV-26 Merkle path for the current Keychain
   credential and revalidates the capture/credential/path association.
3. Builds the current circuit witness in memory, using all seven public inputs
   in circuit order. Mopro scalar inputs are arrays of decimal strings.
4. Generates and locally verifies the real Groth16 proof, comparing **all seven**
   outputs with the expected witness. No fixed DEV-13 synthetic input is used by
   the app adapter.
5. Calls `AppAttestClient.assert(clientDataHash: transcript_hash)` with the same
   enrolled keychain service as enrollment. It requires a previously attested
   key; it does not auto-attest or substitute a development stub on failure.
6. Saves the finalized envelope atomically **before** POSTing it to the configured
   service's `/observations` endpoint.

Proof JSON uses snarkjs format (`pi_a`, `pi_b`, `pi_c`, `protocol: groth16`,
`curve: bn128`), not the Solana precompile byte representation. Public inputs
are seven canonical decimal BN254 scalar strings. This wire remains:

```json
{
  "transcript": "<base64 Borsh>",
  "assertion": "<base64 assertion>",
  "key_id": "<opaque enrolled key ID>",
  "zk": { "proof": "<snarkjs object>", "public": ["<seven decimal fields>"] }
}
```

`evidence` is omitted for current DEV-30 captures; the generic envelope supports
optional base64 evidence and checks its exact hash. Witness inputs are never
encoded into an envelope, queue or network request.

## Mopro-enabled app build

The regular checked-in `Pathnod.xcodeproj` remains usable without generated
Mopro artifacts. It displays an explicit unavailable-prover message when the
user requests submission, without sending a fake proof/assertion.

Use the existing DEV-14 preparation process with the development proving key.
Do not commit the single-machine proving key or treat it as a production
ceremony. With the pinned Mopro CLI and XcodeGen prerequisites in
[DEV-14](../apps/ios/MoproObservation/README.md):

```sh
apps/ios/MoproObservation/prepare-local.sh /tmp/REPLACE_WITH_DEV13_ARTIFACTS
cd apps/ios/MoproObservation
mopro build --mode release --platforms ios \
  --architectures aarch64-apple-ios aarch64-apple-ios-sim --no-auto-update
xcodegen generate --spec submission-project.yml
```

Open the generated `PathnodSubmission.xcodeproj`, select the
`PathnodChallengeScan` scheme and your development team, and enroll on a real
iPhone against the same DEV-26 service. The project uses the real ChallengeScan
UI, generated bindings/framework, bundled `.zkey` and `PATHNOD_MOPRO` compilation
condition. Do not add this flag to the regular project without the bindings and
framework. A simulator cannot provide real BLE or Apple App Attest evidence.

## Durable outbox and failures

`ObservationOutbox` stores at most 128 envelopes and the latest 1,024 receipt
identifiers in Application Support. On iOS the file uses complete file
protection and is excluded from backup. A corrupt/oversized file fails closed
without silently clearing it. Queue overflow is reported, not handled by
dropping an observation. A receipt contains only endpoint/hash in local history.

Entries are bound to their original endpoint. Editing the service URL does not
send an old envelope to a different service. The default transport uses an
ephemeral URLSession and refuses redirects. HTTPS is required; debug builds
may explicitly allow loopback or `.local` HTTP. Pending entries retain the
original transcript time, proof and assertion across app restarts. Retry JSON
is sorted deterministically; no new assertion/counter is generated for a retry.

Retries occur on entering the observation screen, returning that screen to the
foreground or pressing **Retry due observations**. Network failures, invalid
receipts, HTTP 408/429 and server errors use persisted exponential backoff
(2 seconds up to 1 hour). This is foreground/manual retry, not an iOS background
scheduling guarantee. A failed send stops the serial drain before a later Apple
assertion is submitted. Other 4xx responses are retained and labelled rejected,
not automatically retried. The original capture remains in the DEV-30 cache if
proof/assertion preparation fails before queueing. No timestamp is refreshed to
make an old capture look fresh; DEV-33 must enforce epoch/freshness policy.

For each endpoint, the first unrejected entry blocks newer entries even while
its retry deadline is in the future. This FIFO rule survives restarts. Changing
the configured service does not block preparation for an independent service:
old entries remain saved and can be retried by restoring their original URL.
The queue counts cover all endpoints, while preparation and retries use only
the selected endpoint. No old entry is deleted or automatically rebound.

Endpoint isolation assumes independent services. Different URLs backed by the
same verifier/counter ledger are not independent assertion streams: accepting
a newer assertion through one alias may invalidate an older assertion queued
under another. Keep a stable canonical service URL; drain pending observations
before migrating an existing verifier to a new URL.

Only a `202` JSON receipt with `status: received`, matching `transcript_hash`
and `policy_validated: false` removes an envelope and records the receipt
locally. A generic 2xx, wrong hash, redirect or invalid body cannot clear it.
After confirmation, the last 1,024 endpoint/hash receipts prevent repeated
queueing of the same observation. This is not a payment receipt.

## Development receiver

The enrollment server now recognizes `/observations`, but returns **503** by
default. Set `PATHNOD_DEV32_RECEIPT_DB` to an isolated local SQLite file to enable
the explicit development receiver. It refuses startup in production or on a
non-loopback bind address, and refuses non-loopback requests even when called
programmatically. No authenticated production receiver or new public server
exposure is enabled by this increment.

Keep the existing DEV-26 environment settings; for example:

```sh
PATHNOD_DEV32_RECEIPT_DB=/tmp/pathnod-dev32-receipts.sqlite \
  pnpm --filter @pathnod/verifier enrollment:serve
```

The receiver checks exact envelope fields, bounded canonical base64, Borsh
framing, evidence hashes, decimal/point shapes and six public inputs against
the transcript. It does **not** verify the App Attest signature, Groth16 proof,
published root, registry, BLE signatures, counters, freshness or payment policy.
These are DEV-33. A well-framed fake proof can deliberately receive a development
receipt; the response always says `policy_validated: false`. The public parse
helper is framing validation only, not an authorization API.

SQLite persists only transcript hash, canonical envelope digest and reception
time. It does not persist key IDs, assertions, full transcripts or evidence.
Identical retries return the same receipt, including after restart. A changed
envelope for an already-received transcript returns 409; a full 4,096-entry inbox
returns 507 without evicting receipt history. The body is bounded at 128 KiB and
individual assertion/evidence objects at 16 KiB.

The loopback-only sink is suitable for the local synthetic integration test,
not a physical iPhone endpoint. Hardware testing of the complete submission
will require the later authenticated DEV-33 receiver and a reachable HTTPS
URL. Do not expose this development sink through a tunnel or reverse proxy.

## Automated validation

Normal Swift/Node CI automatically includes the new tests. Prover artifacts are
not committed, so the real Mopro tests remain explicit opt-in tests:

```sh
swift test --package-path apps/ios
pnpm --filter @pathnod/verifier typecheck
pnpm --filter @pathnod/verifier test
cargo test --manifest-path apps/ios/MoproObservation/Cargo.toml \
  --locked --test submission_observation -- --ignored
```

The real Mopro test proves both signed DEV-31 capture fixtures, checks the seven
public inputs and verifies the proofs. For cross-language HTTP integration:

```sh
PATHNOD_DEV32_SWIFT_ENVELOPE=/tmp/pathnod-dev32-envelope.json \
  swift test --package-path apps/ios
PATHNOD_DEV32_MOPRO_PROOF=/tmp/pathnod-dev32-proof.json \
  cargo test --manifest-path apps/ios/MoproObservation/Cargo.toml \
    --locked --test submission_observation -- --ignored
PATHNOD_DEV32_SWIFT_ENVELOPE=/tmp/pathnod-dev32-envelope.json \
PATHNOD_DEV32_MOPRO_PROOF=/tmp/pathnod-dev32-proof.json \
  pnpm --filter @pathnod/verifier test
```

These exports are explicitly synthetic public fixtures, not real user
observations. The integration replaces the test proof in the Swift envelope
with a real Mopro proof, checks identical public inputs and requires the local
HTTP receipt. The assertion is injected test evidence, not a real Apple
assertion. Never export physical captures to these test paths.

Local validation: 146 Swift tests; 37 Node tests passed with one unrelated
Apple validation test skipped; both DEV-31 witnesses produced verified real
Mopro proofs; unsigned standard app builds passed for iOS and Simulator; the
`PATHNOD_MOPRO` app sources typechecked against freshly generated simulator
bindings. Node was 24.15.0 locally versus the CI pin 24.21.0. The generated
XcodeGen submission project was not built locally (XcodeGen is not installed).
Real iPhone App Attest/BLE submission and a production receiver remain untested.
