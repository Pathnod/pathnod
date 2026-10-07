# DEV-29 — device observation-slot eligibility

The enrollment HTTP server exposes Device Spec v0 §4.3:

```http
GET /devices/{device_id}/slots?epoch=2961
```

```json
{
  "registered": true,
  "protocol_id": "0xe7000e08162b59f28305ffe9debc0fa343112e055b8f24bb0bef69171831126b",
  "open_slots": 3,
  "reward": "0.05",
  "policy_version": 1
}
```

The endpoint is public and reads Solana accounts without a signer. It does not
enroll an observer, reserve a slot, submit an observation or transfer tokens.

## Lookup and response

Each request derives the protocol configuration, device registry and device-epoch
PDAs and reads all three accounts in one RPC bank at `confirmed` commitment.
The service checks account owners, allocation, Anchor discriminators, protocol ID,
device key/ID correspondence, curve, policy, escrow address and expected reward
mint. Missing or inconsistent required data cannot produce a successful quote.

`registered` describes registration under the selected protocol. For an unknown
device, the response is HTTP 200 with `registered: false`, `open_slots: 0` and
`reward: "0"`; it retains that protocol's ID and policy version. A registered
device with exhausted slots remains registered and may still be observed unpaid.

Available slots are `max(0, slots_per_epoch - paid_slots_used)`. An absent
`DeviceEpoch` account means zero recorded consumed slots. A present account must
decode correctly; wrong-owner or malformed data is an error, not an empty epoch.
Paid slots cannot exceed the recorded independent-observer count.

`reward` is the configured amount per paid slot, expressed in six-decimal token
units using integer arithmetic. Redundant trailing zeros are omitted (`50000`
base units becomes `"0.05"`). It stays the configured amount when slots are
exhausted. The quote does not guarantee a subsequent payment or sufficient escrow
funding. The submission/payment transaction must enforce availability atomically.

## Counter boundary with DEV-35/36

DEV-29 defines only the **read contract** from spec §7.2:

| Account | PDA seeds | Layout including discriminator |
| --- | --- | --- |
| `DeviceEpoch` | `"epoch", protocol_id, device_id, epoch.to_le_bytes()` | 75 bytes |

The fields are `independent_observers: u16`, `paid_slots_used: u8`,
`observation_root: [u8;32]` and `confidence_commitment: [u8;32]`, after the eight-byte
Anchor discriminator. Integer encoding and the four-byte epoch seed are
little-endian. The SDK provides the PDA helper and decoder. DEV-35/36 must use
this same contract when they add account creation and counter updates.

The roadmap assigns accepted-observation accounting to **DEV-35** and payments
to **DEV-36**. This increment adds no on-chain counter writer. The existing
DEV-16 submission spike does not consume the registry or update these counters.
Consumed-slot cases are exercised with explicit test fixtures; the current
DEV-27 devnet fixture has no epoch account and has zero recorded consumption.

## Inputs and errors

IDs accept exactly 32 bytes as hex, with or without `0x`; uppercase input is
normalized to lowercase `0x` output. The protocol ID must be nonzero. `epoch` is
required, unique, and a canonical unsigned decimal u32 (0–4,294,967,295). Negative
numbers, fractions, scientific notation and redundant leading zeros are rejected.
The query selects an epoch for lookup; observation freshness is checked by the
future verifier policy, not by this endpoint.

`protocol_id=HEX32` is an optional query parameter for another protocol under
the same deployment. Without it, lookup uses the explicitly configured default
protocol. Duplicate parameters and unsupported parameters are rejected. The
service does not scan the registry or guess which protocol owns a device.

| HTTP status | Result |
| --- | --- |
| 200 | The five spec fields, including `registered: false` for unknown devices |
| 400 | `invalid_input` |
| 404 | `protocol_unknown`, or `not_found` for an unrelated route |
| 405 | `method_not_allowed`, with `Allow: GET` |
| 503 | `eligibility_unavailable`, `rpc_unavailable` or `account_mismatch` |

Responses use `Cache-Control: no-store`. RPC requests time out after ten seconds;
raw RPC URLs, credentials and errors are not returned to the client.

DEV-30 adds `X-Pathnod-Epoch-Seconds` to successful responses, from the same
configuration snapshot. The five JSON fields are preserved. The iPhone uses
this header to resolve protocol-specific epoch lengths and requery the correct
epoch before sending a challenge.

## Server configuration

Keep the App Attest/enrollment configuration from the
[DEV-26 runbook](dev26-observer-enrollment-service.md) and add:

```sh
pnpm --filter @pathnod/solana build
pnpm --filter @pathnod/verifier build
export PATHNOD_ELIGIBILITY_RPC_URL=https://api.devnet.solana.com
export PATHNOD_ELIGIBILITY_PROGRAM_ID=REPLACE_WITH_DEPLOYED_PROGRAM_ID
export PATHNOD_ELIGIBILITY_PROTOCOL_ID=REPLACE_WITH_PROTOCOL_HEX32
node packages/verifier/dist/enrollment-http.js
```

These three eligibility settings are required together. If they are absent,
the server keeps its existing routes and eligibility requests return 503.
The optional `PATHNOD_ELIGIBILITY_REWARD_MINT` sets the expected six-decimal mint;
its default is devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
Local integration tests explicitly select their synthetic six-decimal mint.

The client permits localhost or HTTPS providers whose genesis hash matches
devnet, and checks that the configured program is executable and owned by the
upgradeable loader. Eligibility requires no root-publication signer. The runtime
enrollment routes continue to use the real App Attest gate.

## Validation

Eight eligibility tests cover the spec response, partial/exhausted/free quotas,
micro-unit and u64 reward precision, unknown devices/protocols, invalid inputs,
protocol/epoch isolation, corrupt accounts, public HTTP access, RPC error redaction
and the production RPC reader. Two additional SDK tests cover the epoch PDA vector
and 75-byte decoder. Existing enrollment and publication tests also pass.

The Anchor CI job uses the accounts created by the DEV-27 registry harness and
runs `eligibility:verify` after DEV-28 root publication. The harness uses a gate
that denies enrollment and checks that HTTP reads preserve chain account bytes
and the enrollment root.

```sh
pnpm --filter @pathnod/verifier eligibility:verify \
  --rpc http://127.0.0.1:18899 \
  --registry-report /private/tmp/dev27-registry-report.json \
  --database /private/tmp/dev29-validation.sqlite \
  --report /private/tmp/dev29-eligibility-report.json
```

The registry report supplies `program`, `protocolId`, `deviceId` and `rewardMint`.
The harness also accepts official devnet and an existing registry report. All
generated databases and reports must stay outside Git; no wallet is required.

### Devnet result — 2026-10-06

The HTTP harness read the existing DEV-27 test registry on devnet:

- Program: `DZq4Tt49QsdWzN8H4PijtRCoVbx1LC8HxxWUKSoP1HuA`.
- [Protocol account](https://explorer.solana.com/address/FEXsX36ecz2CAjRTrCoxZquYsgGQcrrzYvGLWcVQBuke?cluster=devnet).
- [Device registry](https://explorer.solana.com/address/8T2tK23sWEVTngD8ovy5uy9jefVK5uQ5imQj722EtBvN?cluster=devnet).
- Device ID: `0x09e101c7692d1381a319ebff42e8522161b242da57bdd402637814531896b3e5`.
- Epoch **2961**: registered, **3 open slots**, reward **`"0.05"`**, policy **1**.
- No epoch account exists for that fixture, so consumption is **0**.
- Repeated reads, unknown-device/protocol responses and duplicate-epoch rejection
  passed. Protocol/device/epoch bytes and the local enrollment root were unchanged.

This validates a registered development fixture, not a new physical observation
or a payment. No transactions were sent by the eligibility harness.
