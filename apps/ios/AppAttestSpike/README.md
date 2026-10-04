# DEV-18 App Attest iPhone spike

This development app calls `DCAppAttestService.generateKey`, `attestKey`, and
`generateAssertion` on a supported iPhone. Its App Attest entitlement selects
the development environment. The app creates one random, local challenge for
attestation and two distinct random, local challenges for assertions. It shows
only a short hash of the key identifier and returned object lengths.

`PathnodAppAttest` stores the opaque key identifier in this device's Keychain
before asking for attestation. A `serverUnavailable` error keeps that identifier
and its client data hash for a later retry, including after relaunch; other
attestation errors discard the record so the next attempt creates a new key.
The private key remains managed by App Attest. The stored
`attestationReturned` flag records only that Apple's API returned a nonempty
object; it does not mean a server validated the attestation. The app reuses the
key on later runs and requests two new assertions.

## Run

1. Connect a physical iPhone with Developer Mode enabled. Sign in to a valid
   Apple Developer account in Xcode and select its team for both targets. The
   team must be able to provision `xyz.pathnod.appattestspike` with the App
   Attest capability. Keep automatic signing enabled.
2. From this directory, run `xcodegen generate --spec project.yml` and open
   `PathnodAppAttestSpike.xcodeproj` in Xcode.
3. Select the iPhone and run `PathnodAppAttestSpike`. Tap **Run App Attest
   trial**. A successful first run shows a new key, an attestation object, two
   assertion object lengths, and `Succeeded`. Relaunch and run again to check
   key reuse.
4. Run `PathnodAppAttestSpikeUITests` on the same iPhone for the automated
   generation path. It uses a fresh Keychain record, verifies a newly returned
   attestation and two assertions, then relaunches the app to verify key reuse
   and two more assertions. Run `swift test` from `apps/ios` for the isolated
   state and retry tests.

The generated Xcode project and build outputs are ignored. The bundle
identifier is for this spike only; a different identifier needs its own App
Attest provisioning and Keychain service value.

## Validation boundary

The local challenges demonstrate object generation only. They are not issued
or verified by a server, and the client does not parse or trust its own
attestation or assertions. DEV-19 must validate the attestation certificate
chain, app identity, challenge binding, and assertion counter on the server
before any hardware assurance claim replaces the development stub.

## Evidence

- Swift package tests: `swift test` passed on macOS, including all 6
  `AppAttestClientTests`.
- Unsigned iOS Simulator build: succeeded. The Simulator does not provide a
  physical device App Attest result.
- Physical iPhone run: passed on 2026-10-03 with Xcode 27.0, iPhone 16 Pro on
  iOS 27.0, and development team `U5MCCC24G5`. The UI test asserted a new
  key, a nonempty attestation, two assertions for distinct challenges, the
  same key after app relaunch, and two more assertions. XCTest reported 1
  passed, 0 failed.
