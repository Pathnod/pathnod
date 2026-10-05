# DEV-26 — observer enrollment and Merkle paths

Issue: [#55](https://github.com/Pathnod/pathnod/issues/55). This stacks on
DEV-25, which creates `s_obs` in the iPhone Keychain and computes
`c_obs = Poseidon(s_obs)` locally. The enrollment server never receives
`s_obs`.

## Protocol

The iOS client first asks `POST /enroll/challenge` for a one-time 32-byte
challenge, supplying `{ "commitment": "0x…", "keyID": "…" }`. The response
contains `{ id, challenge, mode, expiresAt }`; `challenge` is base64 and
`expiresAt` is Unix milliseconds. The server stores the commitment and key ID
against this challenge. The phone SHA-256 hashes the challenge bytes before
calling Apple's App Attest API. For a new key, `mode` is `attestation`; for a
verified key, it is `assertion`.

The client sends `POST /enroll` with `{ challengeID, commitment, keyID,
object }`, where `object` is the base64 App Attest attestation or assertion.
Both the enrollment challenge and the App Attest gate challenge are consumed
on first use. The server checks the expected App ID, environment, Apple
certificate chain or signed assertion, and strictly increasing assertion
counter before creating or returning an enrollment. Requests with missing or
extra JSON fields, including a client-selected class, are rejected. A failed proof does not
change the Merkle tree. The server assigns class `1` to iOS App Attest; a
client cannot choose or change the class. The observation circuit defines
class `1` as iOS App Attest, `2` as Android StrongBox, and `3` as Android TEE.

The response contains `commitment`, `observerClass`, `leaf`, `leafIndex`,
`siblings`, `directions`, `root`, and `rootRevision`. All field elements are
canonical lowercase `0x` plus 64 hexadecimal digits in the BN254 scalar
field. `siblings` and `directions` have exactly 20 elements, ordered from
leaf to root. A direction of `0` places the current node left; `1` places it
right. Leaves are appended at indices 0, 1, 2, and so on. Empty leaves are
zero; each higher empty node is `Poseidon(empty, empty)`. A populated leaf is
`Poseidon(c_obs, 1)` using the pinned Circom BN254 parameters. The returned
path recomputes to the root and matches the circuit's `merkle_path` and
`merkle_index` inputs.

For an updated path, the client calls `POST /tree/challenge` with the same
commitment and key ID, then `GET /tree?commitment=…` with headers
`x-pathnod-challenge-id`, `x-pathnod-key-id`, and `x-pathnod-assertion`. The
assertion is a new App Attest assertion over the new challenge. `GET /root`
returns the public current root and revision. Path reads require an enrolled
key and a fresh assertion.

Re-enrollment of the same key and commitment requires a fresh assertion,
returns the current path, and appends a `reenrolled` journal event without
changing its leaf or root revision. A key cannot replace its commitment; a
second key cannot claim an enrolled commitment. The SQLite database holds
enrollments, App Attest keys/counters, Merkle nodes, root revisions, and the
append-only enrollment event journal. Back up and restore this database as a
single unit. Run only one enrollment server writer against a database.

## Local iPhone run

From the repository root, build and launch the server with a development
signed app. Use a local database path outside the repository:

```sh
pnpm --filter @pathnod/verifier build
PATHNOD_ENROLLMENT_DB=/private/tmp/pathnod-dev26-enrollment.sqlite \
PATHNOD_APP_ATTEST_APP_ID=U5MCCC24G5.xyz.pathnod.challengescan \
PATHNOD_APP_ATTEST_ENVIRONMENT=development \
PATHNOD_APP_ATTEST_CATEGORIES=3 \
PATHNOD_APP_ATTEST_BUNDLE_VERSIONS=1 \
PATHNOD_ENROLLMENT_HOST=0.0.0.0 \
node packages/verifier/dist/enrollment-http.js
```

The signed ChallengeScan build carries bundle version `1`; the allowlist must
include that signed version. An empty version allowlist accepts only evidence
without the version extension, as used by the earlier DEV-19 spike.
The default port is 8787. The server binds to loopback unless the host is
explicitly changed. Use the Mac's `.local` hostname in the app on the same
local network, for example `http://777.local:8787` on the development Mac.
The iOS app permits local `.local` HTTP for this development flow and HTTPS
for hosted endpoints. Release builds require HTTPS. Do not expose this plaintext development endpoint to
the public internet. For production, terminate HTTPS in a trusted reverse
proxy, set `NODE_ENV=production`, the exact production App ID/environment and permitted validation
categories and bundle versions, and keep the SQLite file private.

Open **Enroll observer**, prepare the commitment, enter the service URL,
and tap **Enroll this iPhone**. The app shows the leaf index, root revision,
root, and sibling count. **Refresh Merkle path** obtains a fresh assertion and
the latest root after more observers enroll. If an initial attestation was
rejected, **Reset failed App Attest key** generates a new Apple key on the
next attempt; it leaves `s_obs` intact.

## Verification

`pnpm --filter @pathnod/verifier test` checks challenge expiry, consumption,
invalid evidence, duplicate and unauthorized enrollment, two appended
leaves, root/path recomputation, re-enrollment, HTTP behavior, and persistence
after restart. The tests use a fake App Attest gate only inside the test
suite; the runtime HTTP server always uses the real `AppAttestGate`. The
existing verifier suite tests Apple's certificate and assertion validation.
The iOS package tests check the pinned arity-one `c_obs` vectors. The
server tests check that pinned commitment vector and the arity-two tree
contract. A signed iPhone build is required for the real App Attest path.

## Device validation — 2026-10-05

- The signed ChallengeScan app was installed on the paired iPhone 16 Pro.
  The owner completed enrollment against the local server and confirmed the
  returned index and root display. The real Apple attestation was accepted
  with development environment, validation category `3`, and signed bundle
  version `1`.
- After restarting the server with only category `3` and version `1` allowed,
  the owner refreshed the path and repeated enrollment successfully. The
  database retained one leaf at index `0` and root revision `1`; the assertion
  counter advanced to `6` and three re-enrollment events were recorded.
- A separate public test secret (`42`) was enrolled through the service. Its
  returned path generated a witness for the existing depth-20 observation
  circuit with Circom 2.2.3; `snarkjs wtns check` reported a valid witness.
  This circuit check uses test data, not the iPhone's private observer secret.
- Verifier typecheck, build, and tests passed (10 passed; the separate DEV-19
  evidence-file test skipped because its raw capture was not supplied).
  The five Swift observer credential tests and the ChallengeScan app tests
  on the iOS simulator passed. The app also built with development signing
  for the physical iPhone.

Raw App Attest objects, key IDs, observer secrets, and the local SQLite
database are not committed or logged. Development error responses may include
the verifier's error code; production responses omit that detail.
