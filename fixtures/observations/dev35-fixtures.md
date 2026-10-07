# DEV-35 public proof and tree fixtures

`dev35-verification-key.json` is the public key exported from the existing local
DEV-13 development proving setup. Its canonical on-chain key digest is
`589090366a5e7b44f436a0608b66177731775cf9e29adc223a901dd784719ffd`.
It is distinct from the DEV-33 public fixture key; those fixtures remain intact.

`dev35-proofs.json` contains real Mopro proofs for the public DEV-31 synthetic
secrets, bound to the first DEV-31 protocol/device and epoch 42. The second
observer belongs to a two-leaf tree, so both proofs can increment the same
device/epoch with distinct nullifiers. All values are synthetic public test data.
No real observer credentials, Apple assertions, proving key or ceremony secrets
are included.

To regenerate with matching local proving artifacts, keep the temporary witness
and output outside Git:

```sh
pnpm --filter @pathnod/circuits exec node scripts/dev35-witnesses.mjs /tmp/dev35-witnesses.json
PATHNOD_DEV35_WITNESSES=/tmp/dev35-witnesses.json \
PATHNOD_DEV35_PROOFS=/tmp/dev35-proofs.json \
  cargo test --manifest-path apps/ios/MoproObservation/Cargo.toml --locked \
    --test dev35_fixtures -- --ignored
```

Export the matching public VK and update the fixtures/compiled constant together
when changing setup. `dev35-reference.mjs` derives shared proof bytes and computes
the tree vectors using a full 65,536-leaf tree, independently of the frontier
implementation. `dev35-trusted-key.mjs` generates the formatted public Rust key.
