# DEV-40 — read-only operator dashboard

The dashboard lives in `apps/dashboard`, separately from the marketing site. It
uses a small Node HTTP backend and native browser modules. No bundler, new external
dependency, wallet or transaction-signing code is added. The existing Pathnod logo
is reused from the marketing site; the cream/forest-green identity is retained.

## Startup

Use Node 24.21.0 and pnpm 11.27.1. Set the server environment using the example
in `apps/dashboard/.env.example`. The example identifies the public historical
Gate 2 deployment, not a new hardware run. `.env` loading is explicit:

```sh
pnpm install --frozen-lockfile
pnpm --filter @pathnod/solana build
pnpm --filter @pathnod/verifier build
pnpm --filter @pathnod/dashboard build
cd apps/dashboard
node --env-file=.env.example dist/server.js
```

Use an external private environment file for actual infrastructure settings.
`PATHNOD_DASHBOARD_VERIFIER_URL` must point to a reachable DEV-39 verifier with
the matching published report. A hash on chain is not enough to recover the
off-chain report. If that service is unavailable, chain data remains visible but
the dashboard shows no active confidence score. No fixture fallback exists.

## Configuration and deployment

- `PATHNOD_DASHBOARD_NETWORK`: `devnet` or `local-validator` only.
- `PATHNOD_DASHBOARD_RPC_URL`: official devnet RPC, or loopback local-validator RPC.
- `PATHNOD_DASHBOARD_GENESIS`: expected cluster genesis; local-validator uses its
  own actual genesis, not devnet's.
- `PATHNOD_DASHBOARD_PROGRAM_ID`, `PATHNOD_DASHBOARD_PROTOCOL_ID`: exact deployment.
- `PATHNOD_DASHBOARD_VERIFIER_URL`: HTTPS upstream or loopback HTTP, without URL
  credentials, query parameters or fragments.
- `HOST`, `PORT`: default `127.0.0.1:4173`.

Keep `dist/` and `public/` together when deploying the dashboard package, and make
the built workspace dependencies available. For `app.pathnod.com`, run this service
behind an HTTPS reverse proxy. Bind to loopback by default. DNS, TLS provisioning,
public exposure and a marketing-site link are not changed by DEV-40. Operators
must add access/rate-limit controls appropriate to their deployment before exposing
the service publicly. It is not a multi-tenant authenticated operator portal.

The browser requests only same-origin `/api/*` endpoints. The server calls the
configured RPC and verifier; no verifier CORS change is needed. RPC/verifier URLs
are not returned in API context. No keys, private databases, attestation identifiers
or requester decryption credentials are read by this application.

## Data contract and safety

Each read checks genesis, executable program/loader, protocol account/PDA and
account ownership/discriminators. Device IDs are derived from registered public
keys and matched to protocol-scoped PDAs. DeviceRegistry has no protocol field:
the reader scans 126-byte program accounts and selects matching PDAs. The scan
has a **global limit of 1,000 accounts**; exceeding it returns an error rather
than pretending a truncated list is complete. The filtered list uses pages of 25.

Device detail scans at most 1,000 commitment accounts across that device's history,
filters the selected epoch, checks every commitment's scope/PDA, and matches its
count to the finalized epoch. All reads request finalized state. Final protocol
and epoch rechecks reject concurrent target changes; this is optimistic validation,
not an RPC guarantee of an atomic snapshot spanning every query.

The backend validates the DEV-39 canonical commitment using the shared verifier
implementation, checks exact scope/policy/root/count against finalized chain state,
and projects only allowed aggregate fields to the browser. Upstream JSON is bounded
to 2 MB. Hash mismatches, unsupported reports and upstream failures display
`unavailable`. A zero on-chain confidence hash displays `stale`; an absent epoch
or missing upstream report displays `missing`. No score remains active on errors.
Confidence reflects its fixed evaluation timestamp, not present-day freshness.

The dashboard serves only GET requests, uses explicit routes, no-store responses,
a same-origin CSP, redirect refusal for upstream fetches, bounded query parameters
and a four-request concurrency limit. Error responses do not disclose upstream
URLs or raw exceptions. Browser text uses `textContent`, never upstream HTML.

Chain commitments establish finalized registration, not policy-receipt status or
pending relay state. The dashboard does not claim to inventory the private relay
queue. A paid slot is reward allocation, not a completed payout. Raw observer
counts do not establish unique humans. `LOW`/`VERIFIED` are DEV-39 policy labels,
not location or anti-relay certificates. Different protocol pseudonyms are not linked.

The detail view schedules its next refresh 15 seconds after the previous poll
finishes, while visible, without overlapping automatic requests. During refresh,
the last successful result remains visible with an updating/last-checked indicator.
An unchanged response preserves the detail DOM; errors clear the previous score.
Selection changes abort previous browser requests and use a generation guard to
ignore late responses. An invalidation becomes visible on the next refresh; the UI
cannot claim instantaneous chain monitoring.

The declared-location map shades the whole geohash6 cell on a local coordinate
grid, not an exact device position. It loads no external tiles or imagery and marks
the operator-provided area as not independently verified. Missing or invalid
locations display an explicit explanation instead of a fabricated map. Geographic
details expose the original geohash and bounding coordinates.

The hardware confidence facet is labelled "Observer attestation": it concerns the
observing phone's App Attest/StrongBox/TEE evidence and enrollment-risk adjustments,
not the authenticity of the ESP32 or other observed equipment.

The default view uses plain-language device, observation, reward and confidence
labels. Expandable details retain epoch/policy identifiers, public keys, raw facet
names and values, hashes and report statuses. The devnet badge explicitly describes
real records on a test network, not production assets; scores are not presented as
probabilities that a claimed location is correct.

## Verification

```sh
pnpm --filter @pathnod/dashboard typecheck
pnpm --filter @pathnod/dashboard test
pnpm --filter @pathnod/dashboard build
```

Tests cover configuration mismatches, canonical report bindings, private-field
projection, response limits, scoped registry reads, fail-closed concurrent changes,
HTTP methods/query validation/headers, malformed-target recovery, geohash cell
decoding, and frontend polling/score clearing/late-response handling. Frontend tests
use the actual browser module with a controlled DOM model;
they are not a physical hardware test or a substitute for real-browser layout QA.
Root CI builds and tests the workspace, and explicitly typechecks the dashboard.

Manual devnet validation uses the public Gate 2 device
`2b52d036962219b5195412a33950044c747666eac5d9e88ddfa39dc613b049b8`, epoch 2962.
Expected values: one raw observer, one paid slot, observation root
`b8c54532cf7f23c1772c1895e570a69417a91ce4f961c5c8a12639f327dd1e56` and confidence
commitment `225f8a755b09c3354ae795f7e4c0b76a6e1719e3163001c83c98f5e036d37e1e`.
With a reachable matching verifier, the report should show LOW, 36.93%, and the
six documented facets. Without it, no active score is shown. No new BLE session,
deployment, withdrawal, faucet or paid transaction is required for these checks.

The implementation was checked in the browser on desktop and a narrow mobile
viewport using finalized devnet accounts. The device, epoch, observer count and
paid slot were displayed correctly, with confidence unavailable and no score.
The author still needs a reachable verifier URL for local published-report checks.
Separately, kazai777 confirmed the real DEV-39 report integration in the PR review:
LOW, 36.93%, with matching finalized commitment, on desktop Safari and a narrow
viewport. No fixture is substituted when the configured service is unavailable.
