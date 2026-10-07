# DEV-37 — reproducible demo bootstrap

`make demo` deploys **a fresh disposable devnet program**, bootstraps its registry,
trusted circuit metadata and payments, registers one explicitly selected device,
publishes an observer root and prepares an observation lookup table. It does not
observe a device, fake App Attest, claim a payment or provision Apple hardware.
DEV-38 owns the filmed physical end-to-end validation.

## Prerequisites (outside the timed setup)

- Node 24.21.0, pnpm 11.27.1, Rust 1.95.0, Solana CLI 4.2.2, Anchor CLI 1.2.0.
  `cargo-build-sbf` and its platform tools must already be installed/cached.
- Run `pnpm install --frozen-lockfile` and build the SDK/verifier workspace packages.
- Export compatible observation WASM, final zkey and seven-input verification key
  **outside Git**. A new DEV-13 ceremony need not match the historical DEV-35 key:
  preparation compiles the supplied public VK into the disposable program.
- A dedicated mode-600 JSON test wallet outside Git, holding devnet SOL and at
  least **0.15 Circle devnet USDC**, mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. USDC must be in its associated
  token account. The CLI derives deployment rent from the prepared binary size;
  it includes peak upload-buffer rent and registry headroom before spending. Prepared
  disposable programs use an explicit capacity equal to the binary size, not the
  default 2x allocation; a later larger upgrade requires a reviewed extension.
  The buffer's temporary rent is refunded by deployment, but must be available
  during upload. Faucets are
  manual and RPC/funding errors stop the run, never switch clusters.
- For hardware mode: a binary 70-byte INFO read from the actual ESP32, and a
  verified enrollment SQLite database with its App Attest keys. The operator is
  responsible for the database's provenance; the bootstrap recomputes its tree
  and checks recorded attestation-key associations, **not** fresh Apple attestations.
- The wallet remains the deployment, enrollment, requester and treasury authority
  for this disposable demo only. Production role separation is out of scope.

## Configuration

Create an external configuration file and a dedicated empty state directory with
permissions 700. Set paths explicitly; the command never uses the default Solana
wallet or `Anchor.toml`'s shared program ID.

```json
{
  "version": 1,
  "freshRun": "demo-2026-10-07-a",
  "stateDirectory": "/absolute/private/demo-a",
  "wallet": "/absolute/private/test-wallet.json",
  "rpc": "https://api.devnet.solana.com",
  "mode": "hardware",
  "wasm": "/absolute/private/circuits/observation.wasm",
  "zkey": "/absolute/private/circuits/observation_final.zkey",
  "verificationKey": "/absolute/private/circuits/verification_key.json",
  "deviceInfo": "/absolute/private/esp32-info.bin",
  "enrollmentDatabase": "/absolute/private/verified-enrollment.sqlite"
}
```

For infrastructure-only testing, explicitly choose `"mode": "fixture"` and omit
both hardware fields. The report then identifies the synthetic device identity
and enrollment root. The known fixture credential/root is public and provides
**no real observer enrollment**. A verifier started from the generated configuration
still needs actual Apple configuration and enrollment; there is no fake HTTP gate.
Fixture proofs use the historical fixture protocol/epoch and are not automatically
submitted to the fresh protocol. Do not confuse setup with a completed observation.

```sh
make demo-prepare DEMO_CONFIG=/absolute/private/demo-config.json
make demo-check DEMO_CONFIG=/absolute/private/demo-config.json
make demo DEMO_CONFIG=/absolute/private/demo-config.json
```

Preparation generates isolated program/buffer/verifier keys, copies build inputs
to the state directory, rewrites only that copy's program ID, generates the trusted
VK and builds SBF. It exports the zkey VK and proves/verifies a synthetic witness
to check compatibility with the WASM/public-input contract. Preparation sends no
transactions. Its synthetic witness is always explicitly identified as an artifact
check, even when hardware mode is selected.

`demo-check` checks tool pins, configuration/artifact hashes, genesis, mint and
funding without sending transactions. `demo` repeats those checks before writing.
The timed run includes preflight, deployment, finalized registry/payments/root
initialization and lookup-table creation. Dependencies, ceremony, SBF compilation,
wallet funding and hardware/Apple provisioning are excluded prerequisites.

## Recovery and isolation

- Resume an interrupted run with the **same** command/configuration. A fingerprint
  rejects changed config, wallet, hardware inputs, toolchain or artifact bytes.
- Signed setup transactions and their signatures are saved atomically **before**
  broadcast. Retry broadcasts identical bytes; pending/ambiguous confirmations halt
  rather than substitute a fresh transaction.
- Existing accounts are read and checked for owners, PDA bindings and expected
  configuration. Escrow funding is not repeated after a verified credit. Existing
  deployments must match the exact compiled binary and upgrade authority; they
  are never overwritten silently.
- The Solana deploy CLI uses persisted program and buffer keypairs. If upload fails,
  resume the same buffer; an already-deployed, verified binary is not redeployed.
- An expired ambiguous setup signature requires inspection of the journal,
  signature history and account state before explicit recovery. Do not delete the
  journal or reset accounts. The bootstrap deliberately stops instead of risking
  duplicate value transfers. A stale lookup creation slot may require a reviewed
  recovery; it is not silently replaced with another table.
- A concurrent run is blocked by `run.lock`. After a crash, verify its PID is no
  longer running before manually removing only that lock file. Keep the rest of
  the state directory. Failed preparation is not overwritten either.
- A second fresh demo requires a **new** `freshRun`, config and empty state directory;
  it gets new program, verifier and protocol identities. No existing deployment is
  reset or closed automatically.

## Outputs and manual steps

`report.json` is a public whitelist: cluster, genesis, program/protocol/device IDs,
PDAs, active root, mint/policy, finalized setup signatures/explorer links, tool and
artifact digests, elapsed setup time, completed and remaining steps, simulation
labels. No private keys, observer envelopes, App Attest identifiers or database
rows are included. Do not publish `state.json`, `verifier-config.json`, key files,
artifact inputs or the full state directory.

`verifier-config.json` provides RPC/program/protocol, pinned VK file digest,
lookup table, signer paths, eligibility/root configuration and iOS prover paths.
It is a private setup reference, not an automatically loaded server configuration.
Set its environment variables and complete the Apple app ID/environment/categories,
HTTPS reachability, iPhone provisioning and matching Mopro artifacts manually.
The generated withdrawal UX still requires devnet SOL and a destination USDC
token account owned by the phone's withdrawal key, as documented in DEV-36.

@kazai777: provide the full ESP32 INFO and the verified iPhone enrollment database
if unavailable locally, then reproduce hardware-mode setup. Confirm the registered
public key/ID, root membership, iPhone/verifier configuration and real observation
→ finalized credit → withdrawal flow. A device ID prefix alone is insufficient to
register a physical identity. Do not send private keys or observer databases in PR
comments; transfer sensitive inputs privately outside Git.

## Validation status

Automated tests cover INFO parsing, canonical roots, ambiguous transaction decisions,
permissions and symlink escapes. Typecheck and live validation results are reported
separately. A successful fixture run does not validate real enrollment, BLE or Apple
provisioning. The <10-minute target is measured by `report.json`, not assumed; another
team member's hardware reproduction remains a separate acceptance check.

Local validation on 2026-10-07 UTC (2026-10-08 in Paris): two fresh fixture-mode
programs completed on an isolated validator. The first took 346.304 seconds including
an intentionally interrupted run and resumed setup; the second took 202.115 seconds.
Each completed nine finalized setup transactions plus deployment, with 0.15 test USDC
escrow, ABI 2 metadata, verified registry/root/payment accounts and an active lookup
table. Re-running the first completed bootstrap sent no new setup transaction.
The validator used explicit local copies of public devnet mint/token accounts, not
real token transfers. SBF preparation and synthetic prover/VK checks passed.

These local runs exercised the original larger program allocation. Subsequent
fresh manifests select binary-sized capacity and include temporary buffer rent in
the funding check. Two fresh fixture-mode devnet environments using the final
520,312-byte allocation completed in 78.206 and 78.273 seconds respectively,
excluding the documented preparation prerequisites. Each deployed a distinct
program/protocol, finalized all nine setup transactions and funded its escrow with
0.15 Circle devnet USDC. The deployed binary, circuit metadata, registry, payments,
active root and lookup table passed the bootstrap's read-back checks.

- [Devnet A deployment](https://explorer.solana.com/tx/3EZqKDgXF6VaKSaeV3G3oehvNK5en264eKwCaJq2WwoY1WTQBYvsMoRMrS3FMAAoS69ptHK4WxuMAcsZD9J13yre?cluster=devnet)
- [Devnet B deployment](https://explorer.solana.com/tx/U132ZmZM9GLZpiZrSfV9jLzSD1i1RJ7ScbtfSGRAkafBQbmUFdWGqxH1ZWZXVRE1wJ6Xk7XLGhwApMwCETJRRg7?cluster=devnet)

Verifier validation: 75 tests passed, two skipped (77 total); typecheck and build
passed. These infrastructure runs explicitly used synthetic device/enrollment
fixtures and do not establish a physical end-to-end observation or withdrawal.
The full INFO and verified physical iPhone enrollment database were not available
locally; the documented hardware-mode reproduction remains pending with @kazai777.
