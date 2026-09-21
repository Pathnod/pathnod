# apps/dashboard

Placeholder. Nothing is implemented here yet.

Planned stack: a Next.js TypeScript dashboard for infrastructure operators, run
as an npm workspace of this repository.

Scope reserved for later roadmap tasks:

- Device/beacon registry views backed by the `pathnod` Solana program.
- Presence-proof history and verification status.
- Operator onboarding flows.

Deliberately out of scope for DEV-01/DEV-02: no UI, no Next.js dependency, no
auth, no payments and no database. The `package.json` here exists only so the
root npm workspace resolves and `npm ci` runs.
