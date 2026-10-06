# DEV-19 App Attest server verification

DEV-19 replaces the DEV-05 development stub with an App Attest verifier. The
server library validates a real attestation against the pinned [Apple App
Attestation Root CA](https://www.apple.com/certificateauthority/private/),
then uses the certified P-256 key to validate assertions. It stores one-time
challenges, the verified public key, and the last assertion counter in SQLite.
The original iPhone harness remains a development tool.
[DEV-26](dev26-observer-enrollment-service.md) connects the observer app and
enrollment HTTP endpoints to this gate.

## Checks

- Attestation: strict CBOR shape, leaf and intermediate certificate signatures,
  validity dates and App Attest key usage, nonce certificate extension bound to
  the server challenge, SHA-256 public-key hash and credential ID against the
  key identifier, COSE key against the certificate, App ID `rpIdHash`, zero
  counter, environment AAGUID, allowed launch validation category, and a bundle
  version permitted by the server policy when present.
- Assertion: strict CBOR shape, signature from the stored key over the nonce,
  App ID `rpIdHash`, matching validation category, a signed bundle version
  allowed by the current server policy, challenge binding, and a counter
  strictly greater than the stored value. The counter and latest authorized
  bundle version use a compare-and-swap SQLite write.
- Challenges expire after five minutes and are consumed on the first attempt,
  including failed attempts. A trial binds its two pending assertion challenges
  to the key only after successful attestation. Reusing a challenge or an old
  assertion fails.

The development policy used for the iPhone spike expects App ID
`U5MCCC24G5.xyz.pathnod.appattestspike`, the development AAGUID, and launch
validation category `3` (development-signed app). Production callers must
provide their own exact App ID, production environment, and permitted launch
categories and bundle versions. The spike allows no bundle version extension,
matching the device evidence captured here. A nonempty `allowedBundleVersions`
list requires an assertion or attestation to carry one of those signed values.
The list can include both the current and previous release while clients update;
the key remains enrolled across that update. Development and production keys
cannot cross those policies.
The development policy is refused when `NODE_ENV=production`.
`AppAttestVerifier` is the stateless cryptographic component; callers must
only pass it a key returned by a successful attestation and kept in trusted
server storage. `AppAttestGate` provides that storage and the challenge/counter
lifecycle for this spike. An untrusted client-supplied public key is never an
enrolled key.

## Reproduce on a physical iPhone

Use Xcode signing with an Apple Developer team that can provision the App
Attest entitlement. Replace the device ID and App ID in the commands below
with the values for the signed app. Run from the repository root. Paths under
`/private/tmp` are local evidence and must not be committed.

```sh
node packages/verifier/scripts/app-attest-trial.ts issue \
  /private/tmp/pathnod-dev19-gate.sqlite \
  /private/tmp/pathnod-dev19-request.json \
  U5MCCC24G5.xyz.pathnod.appattestspike

cd apps/ios/AppAttestSpike
xcodegen generate --spec project.yml
xcodebuild -project PathnodAppAttestSpike.xcodeproj \
  -scheme PathnodAppAttestSpike \
  -destination 'id=DEVICE_UDID' \
  -derivedDataPath /private/tmp/pathnod-dev19-device-dd \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=U5MCCC24G5 build
cd ../../..

xcrun devicectl device install app --device DEVICE_UDID \
  /private/tmp/pathnod-dev19-device-dd/Build/Products/Debug-iphoneos/PathnodAppAttestSpike.app
xcrun devicectl device copy to --device DEVICE_UDID \
  --domain-type appDataContainer --domain-identifier xyz.pathnod.appattestspike \
  --source /private/tmp/pathnod-dev19-request.json \
  --destination Documents/dev19-challenges.json
xcrun devicectl device process launch --device DEVICE_UDID \
  --terminate-existing --environment-variables '{"PATHNOD_DEV19_CAPTURE":"1"}' \
  xyz.pathnod.appattestspike
xcrun devicectl device copy from --device DEVICE_UDID \
  --domain-type appDataContainer --domain-identifier xyz.pathnod.appattestspike \
  --source Documents/dev19-evidence.json \
  --destination /private/tmp/pathnod-dev19-evidence.json
chmod 600 /private/tmp/pathnod-dev19-evidence.json

node packages/verifier/scripts/app-attest-trial.ts verify \
  /private/tmp/pathnod-dev19-gate.sqlite \
  /private/tmp/pathnod-dev19-request.json \
  /private/tmp/pathnod-dev19-evidence.json \
  U5MCCC24G5.xyz.pathnod.appattestspike
```

The request file carries the server's three random challenges. The app creates
a new App Attest key for that trial, hashes each challenge, and writes the
attestation and assertions into its protected app container. The verifier
reads the expected challenges from SQLite, not from the evidence file. The
request file is used only to select the three challenge IDs and check that the
device evidence belongs to the intended trial.

## Evidence from 2026-10-03

The connected iPhone 16 Pro on iOS 27.0 produced an attestation and two
assertions for a fresh server-issued trial. The verifier accepted the Apple
certificate chain and attestation, then accepted assertions with counters `1`
and `2` after reopening the SQLite database between calls. Repeating the same
verification was rejected because the challenges were already consumed.
The focused test suite passed with this local evidence, including tampered
challenge, App ID, environment, validation category, certificate, signature,
and repeated counter cases. The raw objects and SQLite database remain local
and are not tracked by git.

The default test suite also runs without device evidence. It verifies signed
synthetic assertions, authorized version changes, signature and challenge
tampering, counter replay, and a public certificate and nonce sample from
[Apple's validation guide](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide).

```sh
PATHNOD_DEV19_EVIDENCE=/private/tmp/pathnod-dev19-evidence.json \
  node --test packages/verifier/tests/app-attest.test.ts
```

## Limits

This is a server-side library and local device exercise, with no deployed
endpoint, account binding, or production app integration. The attestation
receipt is required to be present but is not independently verified or used
for Apple's fraud-risk metric. Certificate revocation and operational storage
policy also remain outside this spike. Do not treat the UI's local
`attestationReturned` flag as server approval. Apple's [validation
guide](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
and [fraud-risk guidance](https://developer.apple.com/documentation/devicecheck/assessing-fraud-risk)
describe these additional checks.
