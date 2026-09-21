# packages/circuits

Placeholder. Nothing is implemented here yet.

Planned stack: Circom circuits plus snarkjs-based proving tooling for Pathnod's
Groth16 presence proofs, run as an npm workspace of this repository.

Scope reserved for later roadmap tasks:

- The presence-proof circuit and its witness generation.
- Trusted-setup handling and proof/verification-key export.
- Test vectors shared with `packages/verifier` and `programs/pathnod`.

Deliberately out of scope for DEV-01/DEV-02: no circuits, no ceremony and no
tooling dependencies. No proving or verification artifact (`.zkey`, `.ptau`,
generated keys or proofs) may be committed to this repository.

DEV-15 is the task that integrates Groth16 verification on chain, behind the
compatibility gate in `docs/decisions/0001-toolchain-and-monorepo.md`. The
`package.json` here exists only so the root npm workspace resolves.
