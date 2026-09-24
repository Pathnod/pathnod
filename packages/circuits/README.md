# Pathnod Poseidon compatibility harness

This package verifies Pathnod's canonical BN254 Poseidon field contract across
Circom 2.2.3, `circomlibjs` 0.1.7, and the host-only Rust adapter built on
`light-poseidon` 0.4.0.

The single source of expected values is
`fixtures/poseidon/bn254-circom-v1.json`. Its inputs are public test data and
must never be replaced with production observer secrets. Normal tests only
read the fixture; they never regenerate it.

## Encoding note

The field elements `1` and `2` hash to
`7853200120776062878684798364095072458815029376092732009249414926327459813530`.
The `light-poseidon` documentation's output
`6030039056180688046538272648816150486962996124743416649616624837554616801680`
uses two 32-byte arrays filled with `0x01` and `0x02`. Those byte arrays encode
large field elements, not the scalar values `1` and `2`. Both cases are kept in
the fixture to make this serialization boundary explicit.

This harness checks compatibility only. It is not an audit of Poseidon or of
Pathnod's future observation circuit.

## Test

Install the pinned workspace dependencies and make Circom 2.2.3 available as
`circom`, then run:

```sh
pnpm --filter @pathnod/circuits test
cargo test -p pathnod-poseidon-vectors --locked
```
