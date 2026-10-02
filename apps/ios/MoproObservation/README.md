# DEV-14 iOS observation prover

This is a development-only iOS harness for the DEV-13 observation circuit. It
uses Mopro 0.3.7's Circom Arkworks adapter and a witness generated from the
DEV-13 WASM. The app proves the fixed synthetic observation, compares all seven
public inputs with DEV-13's `public.json`, verifies the proof, and reports proof
time and peak resident memory on the device.

## Prepare local artifacts

Run `pnpm --filter @pathnod/circuits dev13:prove` from the repository root as
described in [the circuit README](../../../packages/circuits/README.md). Set
`dev13_dir` to the temporary output directory printed by that command, then:

```sh
apps/ios/MoproObservation/prepare-local.sh "$dev13_dir"
cargo test --manifest-path apps/ios/MoproObservation/Cargo.toml \
  --locked --test local_observation -- --ignored
```

`prepare-local.sh` copies the WASM, `.zkey`, and synthetic input into ignored
`LocalCircuits/`. It also writes `mopro-input.json`: Mopro's Circom adapter
requires arrays of strings for scalar inputs, while the DEV-13 snarkjs input
uses strings. The test generates and verifies a real Mopro proof and compares
all seven public inputs. The generated proving key and input files stay local.

## Build and run on iPhone

Install Xcode, XcodeGen, CMake, Git, Rust, and the pinned Mopro CLI. The Rust
build script downloads and builds `w2c2` at commit
`9de3c2be5a4ed8ef5fdbd536e445120594fb8530`. This fixed revision is needed
because `rust-witness` otherwise clones the moving default branch during a
clean build. A network connection is required for the first build in each new
Cargo target directory.

```sh
cargo install mopro-cli --version 0.3.7 --locked
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cd apps/ios/MoproObservation
mopro build --mode release --platforms ios \
  --architectures aarch64-apple-ios aarch64-apple-ios-sim --no-auto-update
xcodegen generate --spec project.yml
```

Open `PathnodObservation.xcodeproj` in Xcode, select a development team and a
physical iPhone, then run `PathnodObservation`. Tap **Generate and verify
proof**. The app reports proof time in seconds and peak process resident memory
in decimal MB. The target budgets are under 10 seconds and under 500 MB on a
physical device. The `PathnodObservationUITests` target exercises the same
flow on a connected iPhone.

On an iPhone 16 Pro running iOS 27.0, the release build completed the synthetic
proof in 0.122 s with 124.1 MB peak resident memory. The UI test passed with
both budgets enforced. These are measurements from one device run, not a
cross-device benchmark.

The `.zkey`, WASM, inputs, generated Swift bindings, XCFramework, Rust build
output, and generated Xcode project are ignored. Do not ship or commit the
single-machine DEV-13 proving key. This harness establishes local device
feasibility; production key ceremonies and verifier integration are separate
work.
