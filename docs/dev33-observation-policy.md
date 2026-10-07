# DEV-33 — observation verification policy

DEV-33 adds a fail-closed verifier for Spec §7.1. It validates observations;
it does **not** sign `verifier_sig`, relay a transaction, or pay rewards (DEV-34+).
It currently supports registered Ed25519 devices and enrolled iOS App Attest
observers (class 1). Other curves/classes are explicitly rejected, not silently
accepted. The existing DEV-32 receipt sink remains a distinct loopback-only
development mode and cannot be enabled simultaneously.

## Verification order and response contract

`POST /observations` uses the DEV-32 bounded canonical envelope. Malformed
base64, unknown fields, invalid Borsh framing, noncanonical scalars/points and
inconsistent evidence hashes return `400 invalid_observation` (or `invalid_input`
for HTTP framing). Structurally valid failures have this stable precedence:

| Code | Check |
| --- | --- |
| E_DEVICE_UNKNOWN | Transcript protocol matches the configured protocol; registered device ID, registry key and curve; domain-separated SHA-256 device ID matches. |
| E_DEV_SIG | All three Ed25519 signatures over SHA-256 of reconstructed DEV_MSG_V0, with BE wire integers, pseudonym prefix and evidence hash. |
| E_DEV_COUNTER | Capability bit 1 enables strictly increasing counters within the observation and against durable last-seen state. |
| E_RTT | Median of three RTTs ≤400 ms. |
| E_EPOCH | Unix milliseconds within ±600,000 ms of server time; epoch is floor(time / configured epoch duration). |
| E_ASSERTION | Enrolled, unrevoked class-1 key, correct app/environment, valid App Attest assertion on transcript hash and increasing counter. |
| E_ZK | Root among the on-chain last four; all seven inputs coherent; genuine Groth16 verification against the pinned VK. |
| E_NULLIFIER | Nullifier PDA absent in chain snapshot and absent from locally accepted observations. |
| E_RSSI | At least five samples, median ≥configured threshold (default −90 dBm). |

App Attest observations use the transcript hash **directly** as clientDataHash,
matching `AppAttestClient.assert`. Enrollment/tree challenges retain their
existing SHA-256(challenge) behaviour. The direct-hash option is explicit and
does not weaken signature, app, environment or counter checks.

Policy rejections return `422 {"error":"E_…"}`. Missing/untrusted RPC data,
unavailable proof process or incompatible chain configuration return
`503 observation_dependency_unavailable`; they never become “unknown device”.
A caller-supplied transcript for another protocol is instead a permanent
`422 E_DEVICE_UNKNOWN`, rejected before any RPC call or counter mutation.
Retrying that envelope against the same configured service cannot fix it.
The HTTP endpoint permits at most two in-flight validations (`429 observation_busy`),
128 KiB bodies, and a 15-second request-body timeout. Groth16 runs in a disposable
child process with a 15-second deadline and 128 MiB V8 old-space limit, killed
after success/failure/deadline. This V8 limit is not a hard OS RSS limit; production
deployments still need container CPU/memory limits and gateway rate limits.

Success remains HTTP 202, with a distinct body:

```json
{"status":"validated","transcript_hash":"<64 lowercase hex>","policy_validated":true}
```

The iOS outbox accepts only matching `received/false` or `validated/true` pairs,
persists the distinction, and reads older DEV-32 queues without migration loss.
Neither response claims on-chain submission or payment.

## Trusted chain and circuit configuration

The production adapter verifies the RPC genesis and executable upgradeable-loader
program at startup. Each observation reads the configured protocol PDA, device
PDA, enrollment/root-ring PDA and `obs/nullifier` PDA in **one finalized bank**.
Owners, discriminators, lengths, configured protocol/policy version and escrow
address are checked. Capabilities come from DeviceRegistry, not caller flags.
Any existing nullifier PDA blocks acceptance. The program remains authoritative:
this precheck cannot guarantee a future transaction will succeed.

Enable the policy on the existing enrollment server using all five settings:

```sh
PATHNOD_OBSERVATION_RPC_URL=https://api.devnet.solana.com
PATHNOD_OBSERVATION_PROGRAM_ID=<deployed-program-public-key>
PATHNOD_OBSERVATION_PROTOCOL_ID=<64-lowercase-hex-without-0x>
PATHNOD_OBSERVATION_VK=/absolute/path/to/trusted-verification_key.json
PATHNOD_OBSERVATION_VK_SHA256=<sha256-of-exact-VK-file>
```

Keep the DEV-26 `PATHNOD_ENROLLMENT_DB` and App Attest policy configuration.
The policy MUST share that enrollment database, not a separate receipt DB.
Do not set `PATHNOD_DEV32_RECEIPT_DB`. Missing/partial policy settings fail startup;
with no settings `/observations` stays unavailable. This change deploys nothing
and does not enable a new public endpoint by default.

Optional server-owned configuration:

- `PATHNOD_OBSERVATION_POLICY_VERSION` (default 1; must equal on-chain config).
- `PATHNOD_OBSERVATION_MINIMUM_RSSI` (default −90, integer −127…0).
- `PATHNOD_OBSERVATION_GENESIS` (default Solana devnet genesis; explicitly pin the
  genesis when testing a local validator).

The VK must be a trusted seven-input DEV-13 BN254 Groth16 key, pinned by its
exact SHA-256, never supplied by a request. The checked-in fixtures are solely
for automated tests and do not represent a production ceremony.

## Durable state, retries and revocation

SQLite stores transcript/envelope digests, nullifier, validation time, device
high-water counters and revoked key IDs. It does not store full transcripts,
assertions or optional local signals. Existing enrollment tables already store
key identifiers and enrolled public keys; this remains verifier-private data.

All policy checks precede mutation. Final acceptance performs one immediate
transaction: recheck enrollment/revocation, compare-and-swap the same App Attest
counter used by enrollment/tree assertions, recheck device counter/nullifier,
then commit counters and receipt together. Concurrent requests and process
restarts cannot bypass persisted counter checks. Failure rolls back all changes.

An identical canonical envelope returns its historical receipt after a lost
response, including after restart or expiry. It does not consume a counter again.
A changed envelope for an already validated transcript returns E_NULLIFIER before
the normal policy pipeline. A receipt is historical evidence of this verifier's
past validation, **not a new authorization**: DEV-34 must account for current
on-chain/root/policy state before relaying.

The receipt ledger defaults to 100,000 entries; capacity returns retryable
`507 observation_capacity`, without evicting replay history. The database target
includes cluster/program/protocol/policy/RSSI, VK hash and App Attest policy.
Do not silently switch targets or erase counter history. SQLite WAL files need
the same access controls, backups and retention planning as the main database.

`ObservationPolicyService.revoke(keyID)` is a local operator API, not a public
HTTP endpoint. New observations from revoked keys fail E_ASSERTION, including
revocation during proof verification. It does not withdraw earlier receipts or
remove leaves from historical on-chain roots.

## Tests and remaining hardware validation

```sh
pnpm --filter @pathnod/verifier typecheck
pnpm --filter @pathnod/verifier build
pnpm --filter @pathnod/verifier test
swift test --package-path apps/ios
```

Normal CI runs all nine code tests, boundary/replay/restart/concurrency/CAS tests,
chain-account validation and a real Mopro Groth16 proof with valid fixture device
signatures and a synthetic enrolled P256 observer signature. This exercises
cryptographic assertion verification, **not** real Apple attestation enrollment.
See [public fixture provenance](../fixtures/observations/dev33-fixtures.md).

Before claiming physical end-to-end completion:

1. Use the DEV-32 Mopro-enabled iPhone app, real enrolled App Attest key, registered
   ESP32 identity and published matching root against a reachable HTTPS verifier.
2. Collect a fresh observation, submit and confirm `validated/true` and all seven
   public-input bindings; confirm the app displays validation without claiming payment.
3. Repeat the identical HTTP envelope and verify the same receipt; attempt an
   altered replay and stale counters and verify rejection.
4. Test offline/restart/ambiguous network failures, revocation and expiration.

An iOS Simulator cannot provide physical BLE or a real App Attest assertion.
HTTPS termination, gateway quotas, deployment monitoring and infrastructure
resource limits remain necessary before exposing this service publicly.

Local checks: 48 verifier tests passed, two pre-existing opt-in tests skipped;
147 Swift tests passed; verifier typecheck/build passed; unsigned simulator app
build passed; the PATHNOD_MOPRO app sources typechecked with the existing
generated simulator bindings. Node 24.15.0 was used locally versus the CI pin
24.21.0; pnpm 11.27.1 installed the updated frozen lockfile offline. No physical
iPhone App Attest submission, external deployment or devnet transaction was
performed for this increment.
