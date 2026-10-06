# DEV-27 — protocol, device and observer-root registry

This implements Device Spec v0 §7.2–7.3 (`init_protocol`, `register_device`,
`publish_root`) on top of DEV-26. It does not implement reward transfers or the
complete observation submission policy. The DEV-16 submission instruction
remains a development spike and does not consume these registry accounts.

## Accounts and signers

All IDs and roots are raw 32-byte seeds. Roots use canonical **big-endian BN254**
encoding, matching the DEV-26 service; other integer fields use Borsh little-endian.
Account sizes below include the eight-byte Anchor discriminator.

| Account | PDA seeds | Bytes | Write authority |
| --- | --- | ---: | --- |
| `ProtocolConfig` | `"protocol", protocol_id` | 185 | Requester at initialization |
| `DeviceRegistry` | `"device", protocol_id, device_id` | 126 | Protocol requester |
| `ObserverRoot` | `"root", root` | 84 | Designated enrollment service |
| `EnrollmentAuthority` | `"enrollment-authority"` | 176 | Program upgrade authority at bootstrap; enrollment service for publication |
| SPL escrow | `"escrow", protocol_id` | 165 | Protocol PDA owns token balance |

The first three accounts contain the exact fields from §7.2. A device with
absent optional fields still receives its maximum allocation; unused bytes are
zero. Accounts are immutable in this increment except for the enrollment
publication counter and recent-root ring.

`initialize_enrollment_authority(authority)` is a one-time deployment bootstrap.
It requires a signature from the actual upgrade authority stored in the
upgradeable loader's `ProgramData` for this program. A requester cannot nominate
the global enrollment signer. Bootstrap must happen before the deployment is
made immutable; signer rotation is not provided by this increment.

`init_protocol` accepts a nonzero protocol ID, positive epoch duration, nonzero
verifier, positive policy version, reward amount in base units and a `u8` slot
count. Zero slots permits unpaid observations; paid slots require a nonzero
reward. Protocol IDs are caller-assigned: requesters should derive unique IDs
including their public key. The first initialization reserves that ID.

The escrow is initialized through legacy SPL Token `InitializeAccount3`, with
the protocol PDA as token authority, no delegate and no close authority. The
requester pays rent. The supplied mint must be an initialized legacy SPL mint
with six decimals. This validates the token format, not the issuer: requesters
must select the intended USDC mint and clients must check it. The devnet harness
uses `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`; local tests use a synthetic
six-decimal mint. Token-2022 is not accepted by the runtime. Its Cargo feature is
enabled only for IDL generation because Anchor SPL 1.2.0's IDL implementation
references its interface types.

`register_device` requires the requester signature. It recomputes
`SHA-256("Pathnod/device/v0" || K_dev)` and rejects a mismatched ID or zero key.
Ed25519 (`curve=1`) is supported. Optional P-256 needs a public-key encoding
decision and is rejected for now. Capabilities are requester declarations, not
hardware certifications. An optional geohash must contain six lowercase geohash
characters and is also only a declaration.

An optional external asset is recorded with **`linked=false`**. Supplying
`proof_of_control` is rejected: the ecosystem-specific adapters and linked
registration are DEV-43. No claim of Helium/DePHY asset ownership is made here.

`publish_root(root, leaf_count)` accepts only canonical BN254 roots and a count
of 0–1,048,576 for the depth-20 tree. It creates an immutable, globally scoped
root account with a chain timestamp and publisher. The authorized publisher
attests to the tree; the program does not recompute it. Repeated publication of
the same root fails without changing its timestamp or the publication counter.

The extra enrollment account keeps a four-entry ring and a `u64` publication
count. `activeRoots` returns newest first, considering only initialized entries
(a published zero root is valid). Older immutable root accounts remain on chain.
The future observation path must check both account existence and membership
in this active window; existence alone does not establish current eligibility.

## Client and tests

`@pathnod/solana` provides instruction builders, PDA helpers, Borsh decoders and
the recent-root window helper. Callers must check account ownership and derive
the expected PDA before trusting decoded bytes. IDs are buffers; `fieldBytes`
converts a canonical field integer into the required big-endian root seed.

```sh
pnpm install --frozen-lockfile
pnpm --filter @pathnod/solana typecheck
pnpm --filter @pathnod/solana test
cargo test --workspace --locked
```

The integration harness checks bootstrap authority, protocol ownership,
device identity, curve, external proof rejection, geohash, root canonicality,
tree capacity, PDA substitution and duplicate writes. Successful transactions
are confirmed and their account bytes checked. Negative cases are **RPC
simulations**, followed by checks that failed writes created no accounts or
changed no existing records. A fifth publication evicts the first root from the
active window while preserving its immutable account.

CI builds the SBF program and IDL with the pinned toolchain and runs this harness
on an Agave 4.2.2 local validator. SDK tests cover the BLE identity vector,
seed scope, field bounds, compact optional data and root-window decoding.
Rust tests also check the BLE identity vector and account allocations.

## Reproduce on a disposable deployment

Use Anchor 1.2.0, Agave 4.2.2 and SBF tools v1.57, architecture v3. Use an isolated
checkout and keep all keypairs, ledgers, binaries and reports outside Git. Create
a fresh program keypair and set its public ID in that checkout's `declare_id!`
and `Anchor.toml` before building. Do not redeploy the shared program for a test.

```sh
anchor build --tools-version v1.57 --arch v3
solana program deploy /tmp/DEV27_BUILD/target/deploy/pathnod.so \
  --program-id /tmp/DEV27_PROGRAM_KEYPAIR.json \
  --url https://api.devnet.solana.com --keypair /tmp/DEV27_TEST_WALLET.json --use-rpc
pnpm --filter @pathnod/solana registry:verify \
  --rpc https://api.devnet.solana.com --wallet /tmp/DEV27_TEST_WALLET.json \
  --program REPLACE_WITH_DISPOSABLE_PROGRAM_ID --report /tmp/dev27-report.json
```

The test wallet must be the deployment's upgrade authority. The harness checks
the cluster genesis, blocks the shared program ID and requires an uninitialized
enrollment account. It funds two ephemeral test signers, creates a seven-decimal
mint for a rejection test, and leaves its test accounts on chain. Each run needs
a fresh program deployment. Add `--root 0xHEX32 --leaf-count N` to test a public
root from DEV-26; absent these options it uses a synthetic fixture. The four
additional roots used to exercise eviction are always synthetic.

## Recorded validation

Local validation on 2026-10-05 confirmed all twelve transactions and rejected
all seventeen negative simulations. It published the public root from the
DEV-26 physical iPhone enrollment (one observer):
`0x304c122585b33e366799254b9ae53ccd86f7c40d68b307ad2b55212844107204`.
No observer secret, App Attest key ID, attestation or SQLite database is used
by the chain harness or committed to the repository.


Devnet validation on the same date confirmed **eleven transactions** (USDC
already exists, so the local six-decimal mint creation is omitted) and rejected
all seventeen simulations. The supplied root and leaf count match the physical
DEV-26 enrollment above; the four eviction-test roots and the device keys are
synthetic. All final account bytes and the escrow mint/authority were checked.

- Test program: `DZq4Tt49QsdWzN8H4PijtRCoVbx1LC8HxxWUKSoP1HuA`.
- Protocol: `FEXsX36ecz2CAjRTrCoxZquYsgGQcrrzYvGLWcVQBuke`.
- Escrow: `HBiPuUPejF12WvyTyt6JQA7Z1oVquXQ1i3ou73grciEV`.
- Device registry: `8T2tK23sWEVTngD8ovy5uy9jefVK5uQ5imQj722EtBvN`.
- Observer root: `J1Ce5L4w2vFHroqnbGYCmER81xVbz51AgzbheUGq2cnz`.

| Instruction | CU | Transaction bytes | Confirmed devnet transaction |
| --- | ---: | ---: | --- |
| `initialize_enrollment_authority` | 9,070 | 310 | [Explorer](https://explorer.solana.com/tx/2tYDRkdMe9Wn28v375pWmiek55DKdB9XsAZzEo117pbFeFeQ2HpeXhPyY3yN4E4BjfQwwAck6xxDkqTQVJmFEj7S?cluster=devnet) |
| `init_protocol` | 15,792 | 424 | [Explorer](https://explorer.solana.com/tx/55TGiKg1Nb3Q2myxEQ3NraW4NL5eTVcjndjV83zeByPsbGj977boFznEvSZe4hWensxZf9aydorAGLycbGJKSPaC?cluster=devnet) |
| `register_device` | 13,371 | 387 | [Explorer](https://explorer.solana.com/tx/2uSAj2TDreHJHztWf4AkaMdDdAAFQzNyhHi2TKzQ5653XPUNqJvFzA8gSL3BrAiPmCL1U7VyeuDAb5ftCj2TDaAy?cluster=devnet) |
| `publish_root` | 10,985 | 313 | [Explorer](https://explorer.solana.com/tx/3kQXwm5U6NybKu1osMN1xb2ffRcp4eSTCSEUMz1fo6brZXkmrNmKDtJcuqPzhSuUTGWcZ2Hq4oigBkapqzZna7cG?cluster=devnet) |

The tested application SBF binary is 321,680 bytes, SHA-256
`7f2a5a3df98a6b4d1434b8b7f3839f9524370cded9a161117a2552d79c455be0`.
The devnet buffer was compared byte for byte with that binary before deployment.
These measurements cover registry operations, not full observation submission.
