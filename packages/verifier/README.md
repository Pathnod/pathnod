# packages/verifier

Placeholder. Nothing is implemented here yet.

Planned stack: a TypeScript off-chain verifier service that checks Pathnod
presence proofs before they are submitted on chain, run as an npm workspace of
this repository.

Scope reserved for later roadmap tasks:

- Proof intake and Groth16 verification against the circuits in
  `packages/circuits`.
- Submission to the `pathnod` Solana program and nullifier bookkeeping.
- Persistence, once there is a concrete use case for it.

Deliberately out of scope for DEV-01/DEV-02: no verification logic, no service,
no auth and no database. The roadmap mentions SQLite/Postgres, but
`docs/decisions/0001-toolchain-and-monorepo.md` defers that choice to the task
that actually implements verifier persistence.

The on-chain counterpart is gated by the DEV-15 `groth16-solana = "=0.2.0"`
compatibility spike described in the same ADR. The `package.json` here exists
only so the root npm workspace resolves.
