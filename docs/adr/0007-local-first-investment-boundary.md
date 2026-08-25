# ADR 0007: Keep investment local-first and defer hosted expansion

- Status: accepted
- Date: 2026-08-25
- Decision: local-first OSS stewardship
- Scorecard: `oss-health-scorecard-v0.1`
- Scorecard digest: `sha256:30a08ef61a0f94b5fcd7608473b275d6d4cf88f67b576e76dbc43cd46c2edf9d`

## Context

M-005's [OSS health and traction scorecard](../OSS_HEALTH_SCORECARD.md)
defines eight evidence dimensions for deciding whether hosted or team scope is
justified. The current snapshot observes only a bounded technical sample: the
R-005 compatibility review contains three successful public repository runs and
two bounded failures. Repeat non-maintainer contributors, public release
stability, issue quality, maintainer load, security history, retention, and
external adopter feedback remain `not-observed`. The scorecard therefore
defers both traction claims and hosted investment.

The complete local workflow already provides the trustworthy product boundary:
an Apache-2.0 analyzer, schemas, reports, policy and ADR contracts, adapters,
the read-only Action, and reproducible local gates. Architecture input can be
proprietary, so the project must not create an account, require source upload,
or add undisclosed collection in order to remain useful. A GitHub Action that
runs the local binary is an integration surface, not authorization for a
hosted source-processing service.

## Decision

CARTOGRAPH will remain a local-first OSS project. The project will invest in
the local CLI, portable schemas, deterministic reports, offline CI integration,
adapter safety, documentation, reproducibility, and maintainer continuity.

This ADR does not authorize:

- a hosted analyzer, hosted source storage, or a required account;
- source upload, hidden telemetry, background collection, or a required
  network path;
- a team workspace, organizational history service, or commercial control
  plane; or
- treating stars, downloads, issue volume, CI runs, or the R-005 sample as
  representative traction or product-market evidence.

Any future discovery phase or hosted/team implementation requires a new public
RFC and a separate reviewed ADR. Before that review, the relevant scorecard
dimensions must contain consented and reproducible evidence, the strategy
branch must complete its privacy/security review (M-009), the sustainability
and cost model must be published (M-010), and the claims audit and capacity
charter must be explicit. A later ADR may still choose to defer, narrow, or
sunset the proposed expansion.

The accepted M-009 [strategy-branch privacy and security review](../STRATEGY_PRIVACY_SECURITY_REVIEW.md)
records the selected `oss-local-first` branch, its assets, actors, data flows,
retention and incident-response assumptions, blocking mitigations, and rejected
collection. Its versioned fixture is validated offline and remains bound to the
same local-first decision.
Review ID: `strategy-privacy-security-review-v0.1`.
Review digest: `sha256:6d64721736a7fad5eea4f940e366ec7723dd66522b23800ed514366ecec5fb1e`.

The accepted M-011 [Year 1–3 claims audit](../CLAIMS_AUDIT.md) maps the
capability, quality, privacy, adoption, and maintenance claims that remain
material to this decision. Its non-verified results feed a conditional
maintenance-first Year 4 charter rather than authorizing hosted or team scope.
Audit ID: `claims-audit-year1-3-v0.1`.
Audit digest: `sha256:9816d6bdc618f4c34113f44f02e080ca3e764bdf27df24f5cfa206406560e71f`.

## Alternatives

- **Authorize hosted discovery now** — rejected because the current scorecard
  has no representative retention, adopter, contributor, release, load, or
  security-history evidence.
- **Build a hosted/team product in parallel** — rejected because it would add
  trust, retention, authorization, and operational boundaries before a public
  decision has earned them.
- **Freeze the OSS project** — rejected because the local loop remains useful
  and the evidence-backed maintenance and compatibility work is within scope.

## Consequences

The roadmap's later hosted, team, funding, and discovery work remains
conditional rather than implicitly authorized by backlog completion. Maintainers
will report unobserved evidence as unobserved, keep raw external material out
of the repository, and prefer public synthetic or consented aggregate records.
The local core remains complete and useful if no future strategy ADR authorizes
an expansion. This decision should be revisited after the scorecard is
refreshed or when a public RFC proposes a materially different trust boundary.
