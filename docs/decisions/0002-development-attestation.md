# ADR 0002 — Development-only attestation stubs

- Status: accepted for DEV-05 (issue #3)
- Date: 2026-09-22
- Scope: the attestation boundary only. Real App Attest (DEV-18/DEV-19), HTTP
  endpoints, Keychain storage, Apple certificate-chain verification, and Android
  attestation stay out.

## Decision

Freeze one attestation contract, implemented twice, so the iOS observer and the
off-chain verifier can integrate before any hardware-backed provider exists. The
contract is shared through `fixtures/attestation/development-stub-v1.json`, not
through cross-language source.

The only implemented provider is a development stub. It proves nothing about the
device.

## Wire format

Schema version 1 is a JSON object with exactly these five fields, and no others:

| Field | Type | Value produced by the stub |
|---|---|---|
| `schemaVersion` | integer | `1` |
| `provider` | string | `development_stub` |
| `environment` | string | `development` |
| `purpose` | string | `enrollment` or `observation` |
| `proof` | string | unpadded base64url, 32 bytes decoded |

The verifier rejects unknown or missing fields rather than ignoring them, so a
wire-format change cannot pass unnoticed. `schemaVersion` is what a later format
is expected to move.

The envelope deliberately carries no client-data hash. The expected 32-byte hash
is supplied separately by the server authority that calls the verifier
(`AttestationVerificationInput.expectedClientDataHash`), together with the
expected purpose. A hash copied from the envelope would prove nothing.

## Proof

```text
proof = SHA-256(
  UTF8("Pathnod/development-stub-attestation/v1")
  || 0x00
  || ASCII(purpose)
  || 0x00
  || clientDataHash
)
```

`clientDataHash` is always exactly 32 bytes. The NUL separators are unambiguous
because neither the domain separator nor a purpose contains a NUL byte, and the
hash has a fixed length. Proofs and client-data hashes are encoded as unpadded
base64url; padding, the standard alphabet, and non-zero trailing bits are
rejected on the server.

### Canonical vectors

`fixtures/attestation/development-stub-v1.json` is the shared artifact, consumed
by both test suites.

```text
enrollment
clientDataHash = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA   (32 zero bytes)
proof          = WcbN5PyXCKC4F3bowF2AqxuFzHSpApZGm0lMY6c7NYc

observation
clientDataHash = AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8   (0x00…0x1f)
proof          = YPaMf6YqXuDgE2N1wMtEuUZn16HWnOEQPkEDIEnAJFA
```

The fixture also carries six `rejectedProofs` vectors (trailing-NUL input,
purpose confusion, truncation, padded base64, non-canonical trailing bits, and
the standard base64 alphabet).

The enrollment proof published in issue #3,
`BFgpcguu12jS_vgk2fTcr_YKwtfhghLfrFI0Jkd0eKI`, does not match the formula that
the same issue specifies: it is the digest of a 33-byte input with a trailing
`0x00` appended after the client-data hash. The fixture keeps the value computed
from the specified formula and records the published one as the
`enrollment-proof-over-trailing-nul-byte` rejected vector. The discrepancy is
tracked separately; issue #3 is left unchanged.

## What this provides, and what it does not

A successful verification returns `provider = development_stub`,
`environment = development`, the verified purpose, and `assurance = none`.

`assurance = none` is literal. The stub gives:

- **No authenticity.** The proof is a public function of the domain separator,
  the purpose, and the client-data hash. Anyone who knows the expected
  client-data hash can compute an accepted proof; no key is involved.
- **No replay protection.** The proof is deterministic and carries no nonce,
  counter, or timestamp. The same envelope verifies forever. Freshness must come
  from whatever the caller binds into the client-data hash, and duplicate
  detection belongs to the later nullifier work.
- **No device binding, no hardware root of trust, no attestation of app
  integrity.**

Every generation and every acceptance emits a warning carrying
`provider=development_stub`, `environment=development`, `assurance=none`, and
the purpose. Warnings never include the client-data hash, the proof, the full
envelope, key identifiers, device identifiers, or credentials.

## Opt-in and fail-closed rules

There is no default provider and no fallback to the stub after a real provider
fails.

- The shared opt-in identifier is the exact string `development_stub`. Matching
  is exact and case-sensitive: `DEVELOPMENT_STUB` is rejected.
- **Server.** `PATHNOD_ATTESTATION_PROVIDER=development_stub` is required.
  Additionally `NODE_ENV` must be one of `development` or `test`; every other
  value, including unset and `production`, is rejected. The check runs at
  factory creation *and* again on every `verify` call, so revoking the
  configuration disables an already constructed verifier instead of leaving it
  armed.
- **iOS.** Only a Debug build may construct the stub. The guard is a compiled
  `#if !DEBUG` in `DevelopmentStubAttestationProvider.init`, so a Release binary
  cannot instantiate it even if the factory is handed
  `buildConfiguration: .debug`. The factory additionally rejects a `.release`
  build configuration before it reaches the initializer.

## Public entry points and typed errors

Swift, `apps/ios` (product `PathnodAttestation`):

- `protocol AttestationProvider { func attest(purpose:clientDataHash:) throws -> AttestationEnvelope }`
- `final class DevelopmentStubAttestationProvider`
- `enum AttestationProviderFactory { static func make(configuredProvider:buildConfiguration:logger:) throws -> any AttestationProvider }`
- `struct AttestationEnvelope`, `enum AttestationPurpose`,
  `enum AttestationBuildConfiguration`
- `protocol AttestationWarningLogging`, `struct AttestationWarningEvent`,
  `struct ConsoleAttestationWarningLogger`
- `enum AttestationProviderError`: `invalidClientDataHash`, `stubDisabled`,
  `stubForbiddenInRelease`, `unsupportedProvider`

TypeScript, `packages/verifier` (`@pathnod/verifier`):

- `createAttestationVerifier(options?)`, `class DevelopmentStubAttestationVerifier`
- `interface AttestationVerifier { verify(input): AttestationVerificationResult }`
- `parseAttestationEnvelope`, `computeDevelopmentStubProof`,
  `evaluateDevelopmentStubEnablement`, `decodeBase64UrlStrict`,
  `encodeBase64Url`
- `AttestationConfigurationError.code`: `E_MISSING_PROVIDER_CONFIGURATION`,
  `E_UNKNOWN_PROVIDER`, `E_STUB_FORBIDDEN_ENVIRONMENT`
- `AttestationVerificationError.code`: `E_MALFORMED_ENVELOPE`,
  `E_UNSUPPORTED_SCHEMA_VERSION`, `E_UNSUPPORTED_PROVIDER`,
  `E_FORBIDDEN_ENVIRONMENT`, `E_PURPOSE_MISMATCH`,
  `E_INVALID_CLIENT_DATA_HASH`, `E_INVALID_PROOF`, `E_STUB_DISABLED`

A later endpoint may map every verification failure to a single public code such
as `E_ASSERTION` and keep these codes internal. This decision adds no endpoint.

## Build and test

TypeScript, from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @pathnod/verifier run typecheck
pnpm --filter @pathnod/verifier run build
pnpm --filter @pathnod/verifier run test
```

Swift, from `apps/ios`:

```sh
swift build
swift test              # Debug: exercises the fixture vectors
swift test -c release   # Release: asserts the stub cannot be constructed
```

The test suite is split by `#if DEBUG`. Tests that need a constructible stub
exist only in Debug; the Release build instead asserts that direct construction
and the factory both fail with `stubForbiddenInRelease`. The tests import
`PathnodAttestation` normally rather than with `@testable`, because testability
is not enabled in a Release build.

## Platform gaps

Honest limits of the current state:

- This Linux review host still has no Swift toolchain, macOS, Xcode,
  simulator, or physical iPhone, so it did not run the Swift package locally.
- DIGIX666 reported running the package on macOS in the
  [PR review](https://github.com/Pathnod/pathnod/pull/6#pullrequestreview-5284620122):
  5 tests passed in Debug and 3 tests passed in Release. This is external
  reviewer-reported package-level evidence, not execution from this Linux host.
- `CryptoKit` and the `.iOS(.v16)`/`.macOS(.v13)` platforms in `Package.swift`
  mean the package builds on Apple platforms only; an open-source Swift
  toolchain on Linux would not build it as written.
- The TypeScript side is verified on Linux via the commands above.
- There is still no iOS application or Xcode project, and no simulator or
  physical-iPhone execution, entitlement validation, or real App Attest call.
- The Swift and TypeScript implementations agree because both are checked
  against the committed fixture, not because either has been run against the
  other.
