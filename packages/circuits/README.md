# Pathnod circuits

This package verifies Pathnod's canonical BN254 Poseidon field contract across
Circom 2.2.3, `circomlibjs` 0.1.7, and the host-only Rust adapter built on
`light-poseidon` 0.4.0.

The canonical Poseidon vectors are in `fixtures/poseidon/bn254-circom-v1.json`;
the ID conversion vectors are in `fixtures/ids/bn254-id-field-v1.json`. Their inputs are public test data and
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

The vector harness checks cross-language compatibility only. It is not an audit
of Poseidon or of the observation circuit.

## DEV-12 observation circuit

`circuits/observation.circom` proves knowledge of an observer credential in a
depth-20 Poseidon Merkle tree, and derives two domain-separated public values:

- `c_obs = Poseidon(s_obs)` and `leaf = Poseidon(c_obs, class)`;
- `nullifier = Poseidon(1, s_obs, protocol_id_f, device_id_f, epoch)`;
- `pseudonym = Poseidon(2, s_obs, protocol_id_f)`.

Each `merkle_index[i]` is constrained to 0 or 1: 0 places the current node on
the left, 1 on the right. `class` is constrained to 1, 2, or 3 and must equal
`class_pub`. The seven public inputs, in Circom's declared order, are `root`,
`protocol_id_f`, `device_id_f`, `epoch`, `nullifier`, `pseudonym`, and
`class_pub`. `s_obs`, `class`, `merkle_path[20]`, and `merkle_index[20]` are
private. The witness contains no BLE measurements or device signatures; those
are verified by the separate observation verifier.

All inputs are BN254 field elements. The host must generate `s_obs` from 31
cryptographically random bytes. The canonical protocol and device IDs are
each exactly 32 raw bytes. Split each ID into bytes `[0..16]` and `[16..32]`,
interpret both halves as unsigned big-endian 128-bit integers `high` and
`low`, then calculate:

```text
protocol_id_f = Poseidon(3, high(protocol_id), low(protocol_id))
device_id_f   = Poseidon(4, high(device_id), low(device_id))
```

The Poseidon parameters are the pinned Circom BN254 x^5 parameters used by
the shared fixture. No byte reversal, string hashing, truncation, or modular
reduction of the raw ID is allowed. The result is a canonical BN254 scalar,
serialized as a 32-byte big-endian value when bytes are needed. Both domains
are distinct from `nullifier` (1) and `pseudonym` (2). The TypeScript and Rust
helpers and fixture tests implement this conversion; the observation circuit
accepts the resulting public field elements rather than hashing raw bytes.

The verifier must derive both fields again from the canonical raw IDs in the
trusted transcript and compare them with the public inputs. The circuit alone
proves consistency with the supplied fields, not their correspondence to
external byte strings. The verifier must compare all seven public inputs with
the trusted enrollment root and transcript; it must not accept prover-supplied
values without that check.

Compile with the pinned Circom 2.2.3 compiler and the existing `circomlib`
dependency:

```sh
circom packages/circuits/circuits/observation.circom --r1cs --wasm --O2 \
  -o /tmp -l packages/circuits/node_modules
packages/circuits/node_modules/.bin/snarkjs r1cs info /tmp/observation.r1cs
```

On Circom 2.2.3 with `--O2`, the circuit has 5,891 constraints and seven public
inputs. This exceeds the spec's approximately 2,000-constraint estimate, but
fits the 2^14 powers-of-tau size used by the local Groth16 flow below. Mobile
proving and on-chain verification remain DEV-14 and DEV-15 work.

## DEV-13 local Groth16 proof

With the pinned Node 24.21.0, installed workspace dependencies, and Circom
2.2.3 on `PATH`, run from the repository root:

```sh
pnpm --filter @pathnod/circuits dev13:prove
```

The command creates a new temporary directory and prints its path. To choose
the location, pass `--out /path/to/empty/directory`; the directory must exist
and be outside this repository. The script compiles the observation circuit
with `--O2`, checks its constraint count and seven public inputs, then performs
a local BN254 powers-of-tau ceremony at power 14. It contributes and applies a
beacon to phase 1, prepares phase 2, creates and contributes to the Groth16
`.zkey`, applies a phase 2 beacon, verifies the transcripts, and exports
`verification_key.json`.

It then generates a proof from a fixed synthetic observer input, checks the
public signals in this order: `root`, `protocol_id_f`, `device_id_f`, `epoch`,
`nullifier`, `pseudonym`, `class_pub`, verifies the proof with `snarkjs`, and
confirms that verification rejects the same proof with a changed root. The
output directory contains the `.ptau`, `.zkey`, R1CS, WASM, input, proof,
public signals, and verification key needed to inspect or repeat individual
`snarkjs` commands. Setup contributions use fresh local randomness on every
run, so the keys and proofs are not reproducible byte for byte.

For example, after setting `dev13_dir` to the directory printed by the script:

```sh
packages/circuits/node_modules/.bin/snarkjs r1cs info "$dev13_dir/observation.r1cs"
packages/circuits/node_modules/.bin/snarkjs groth16 verify \
  "$dev13_dir/verification_key.json" "$dev13_dir/public.json" "$dev13_dir/proof.json"
packages/circuits/node_modules/.bin/snarkjs groth16 verify \
  "$dev13_dir/verification_key.json" "$dev13_dir/public-tampered.json" "$dev13_dir/proof.json"
```

The first verification prints `OK!`; the second reports `Invalid proof`.

**These setup artifacts are for local development only.** A single-machine
ceremony does not establish a production trust assumption. Never deploy its
proving or verification key, and never commit the generated artifacts. DEV-14
will measure iOS proving; DEV-15 will test on-chain verification. The command
does not test either integration.

## Test

Install the pinned workspace dependencies and make Circom 2.2.3 available as
`circom`, then run:

```sh
pnpm --filter @pathnod/circuits test
cargo test -p pathnod-poseidon-vectors --locked
```
