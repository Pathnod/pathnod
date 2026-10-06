# DEV-25 — iOS observer credential preview

Issue: [#53](https://github.com/Pathnod/pathnod/issues/53).

The Pathnod S1 iOS app has an **Observer enrollment** preview. Tapping
**Prepare enrollment preview** generates `s_obs` from 31 bytes supplied by
`SecRandomCopyBytes` on first use. Later taps load the same secret from a separate
Keychain generic-password item (`observer-secret-v1`), marked
`AfterFirstUnlockThisDeviceOnly`. A missing item is the only case that creates a
new credential. Read errors, malformed data, and write errors stop the flow; the
app never silently overwrites an existing credential.

The 31 bytes are interpreted as one unsigned big-endian BN254 scalar by
prepending a zero byte. Because the value is below `2^248`, it is canonical in
the BN254 scalar field without a reduction step. The public commitment is
`c_obs = Poseidon(s_obs)`, serialized as exactly 32 big-endian bytes and shown
in lowercase hex with a `0x` prefix. The app uses the Circom BN254 x^5, arity-1
constants pinned by `circomlibjs` 0.1.7; the resource
`poseidon-t2.json` contains only those public parameters. Swift tests read
`fixtures/poseidon/bn254-circom-v1.json` and compare all arity-1 vectors.

The preview is local. DEV-25 sends no HTTP request and does not enroll the phone.
DEV-26 will define the full request (including class and attestation), verify it
server-side, and return a Merkle path. The secret must never appear in that
request, UI, logs, fixtures, or committed files. DEV-30/DEV-32 will use the same
stored credential for observation proofs.

## Verification

From the repository root:

```sh
swift test --package-path apps/ios --filter ObserverEnrollmentTests
xcodebuild -project apps/ios/Pathnod.xcodeproj -scheme PathnodChallengeScan \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

On the paired iPhone, install the signed `PathnodChallengeScan` app, open
**Preview public commitment**, and tap **Prepare enrollment preview**. Confirm
the full 64-digit hex commitment is shown with the “no request sent” statement.
Force-quit and reopen the app, then tap the same button; the commitment must be
unchanged. Do not record the secret or replace a malformed Keychain record to
make this check pass.

## Validation record — 2026-10-05

- `swift test --package-path apps/ios`: passed, including the five new
  enrollment tests and the existing Swift package suites.
- `PathnodChallengeScan` built for the iOS Simulator and for the paired iPhone
  16 Pro using development signing.
- The signed build was installed on the iPhone 16 Pro. The device owner opened
  the preview and confirmed a `0x`-prefixed 64-digit commitment. Closing and
  reopening the app, then preparing the preview again, displayed the same value.
  The value itself was not copied into the evidence or repository.
- The check demonstrates local display and persistence across app relaunches.
  It does not exercise an enrollment HTTP request, attestation verification, or
  a Merkle path; those belong to DEV-26.
