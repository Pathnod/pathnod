# DEV-31 — canonical observation transcript

`ObservationTranscript` in `PathnodObservationCore` and the exported TypeScript
codec in `@pathnod/verifier` implement Pathnod Spec §4.5. They encode the same
`OBS_TRANSCRIPT_V0` bytes and compute:

```text
SHA-256(ASCII("Pathnod/transcript/v0") || borsh(OBS_TRANSCRIPT_V0))
```

## Wire contract

All Borsh scalar integers and vector lengths are **little-endian**. Fixed-size
byte arrays have no length prefix. IDs and cryptographic bytes are not reversed:
pseudonym and nullifier remain canonical BN254 field elements on 32 bytes,
big-endian. Device BLE fields are big-endian; the capture adapter parses their
numeric values before writing Borsh. JavaScript uses `bigint` for both u64 fields.

| Field order | Encoding |
| --- | --- |
| version | u8, exactly 0 |
| protocol_id, device_id, k_dev | three fixed [u8;32] arrays |
| curve, epoch, obs_time | u8, u32, u64 (original phone Unix milliseconds) |
| challenges | u32 length, exactly 3 entries |
| each challenge | nonce[32], sig_dev[64], dev_ts:u64, dev_counter:u32, rtt_ms:u16, rssi_dbm:i8 |
| local | geohash6[6], gps_accuracy_m:u16, baro_hpa_x10:u16, motion_class:u8, wifi_bssid_hash[32], u32 RSSI count followed by 5–20 i8 values |
| evidence_hash, pseudonym, nullifier | three fixed [u8;32] arrays |
| observer_class | u8, 1–3 |

The complete encoding is **596–611 bytes**, depending on RSSI count. Decoders
bound lengths before allocation, reject unsupported versions, malformed fields,
truncated input and trailing bytes. Codec validation is structural: it does not
replace DEV-33 signature, epoch freshness, root and acceptance policy.

## Capture conversion

```swift
let transcript = try ObservationTranscript(
    capture: capture, credential: credential, enrollment: validatedMerklePath)
let bytes = try transcript.encode()
let hash = try transcript.transcriptHash()
```

The adapter revalidates the completed DEV-30 capture and the enrollment's
commitment/class/Merkle path, checks the capture's pseudonym against the supplied
credential, and computes the circuit nullifier:

```text
protocol_id_f = Poseidon(3, high128(protocol_id), low128(protocol_id))
device_id_f   = Poseidon(4, high128(device_id), low128(device_id))
nullifier     = Poseidon(1, s_obs, protocol_id_f, device_id_f, epoch)
```

Both halves are unsigned big-endian 128-bit values. Observer class comes from
the validated enrollment, never a UI setting. The returned transcript contains
neither the private credential nor the enrollment root/path, App Attest key ID,
precise coordinates, duration diagnostics or epoch-duration metadata.

The original observation time, nonces, signatures, device timestamp/counter,
conservative integer RTTs and local signals are preserved. A restored capture
uses its original time, never the current clock. No new BLE challenge is sent.

## Evidence

Absent evidence uses 32 zero bytes. Explicitly present evidence, including an
empty byte array, uses SHA-256 of those exact bytes. The generic codec supports
both representations. DEV-30's current response parser only supports absent
evidence and its signatures bind the zero hash. Consequently the capture adapter
rejects any supplied evidence rather than attaching an unsigned evidence hash.
Future evidence collection must extend and validate the signed response path
before enabling that adapter input.

## Shared vectors and validation

`fixtures/observations/transcript-v0.json` contains five explicitly public,
synthetic fixtures: absent signals, optional signals, u64/u32/u16 boundaries,
present empty evidence and present nonempty evidence. Expected bytes use an
independent Borsh reference writer; expected nullifiers use circomlibjs 0.1.7.
Two fixtures also contain valid synthetic signed captures and enrollment paths
to exercise the complete Swift conversion. Their seeds/secrets are test inputs,
not real identities. Never regenerate fixtures using physical app captures.

Swift Poseidon arity five uses the pinned circomlibjs t6 parameters (68 rounds).
Existing arity-one/two/three vectors continue to cover enrollment compatibility.

```sh
pnpm --filter @pathnod/circuits exec node scripts/dev31-transcript-vectors.mjs
swift test --package-path apps/ios
pnpm --filter @pathnod/verifier typecheck
pnpm --filter @pathnod/verifier test
```

The existing iOS and Node CI jobs run these test suites. Assertion generation,
Mopro proving, envelope submission and durable retries remain DEV-32. This
increment provides reusable codecs and capture conversion without submitting
an observation or claiming a payment.
