# Conditional Year 4 investment charter

M-012 selects a maintenance-first track for the conditional Year 4 program.
The project will preserve the local-first OSS analyzer and its evidence,
security, compatibility, and maintainer routes while deferring team-scale and
hosted expansion. This is a capacity-gated decision record, not a funding
approval, staffing promise, support SLA, or product-market claim.

The machine-readable source is
[`charter.v0.1.json`](../test/fixtures/year4-charter/charter.v0.1.json),
validated against
[`year4-investment-charter.v0.1.schema.json`](../schema/year4-investment-charter.v0.1.schema.json)
with:

```sh
npm run year4-charter:validate
```

Charter ID: `year4-investment-charter-v0.1`; as of 2026-08-25. The validator
keeps the stable fixture digest in its output and rejects drift in the selected
track, gate digests, owners, capacity boundary, quarter plan, risks, or local
only scope.

## Selected track

The selected option is `conditional-maintenance-first` (`maintenance-track`):

- keep the local TypeScript/Express analyzer, graph and diff contracts, reports,
  policies, adapters, and read-only Action coherent;
- maintain security, dependency, workflow, release-rehearsal, compatibility,
  provenance, and documentation gates;
- preserve public onboarding and handoff routes, repeating a non-author
  rehearsal only when an actual independent contributor is available; and
- defer bounded query, workspace, governed-review, interoperability, and
  assurance-bundle feature work until a later decision earns it.

This is the conservative result of the accepted local-first ADR and strategy
review, the sustainability planning model, the Year 1–3 claims audit, the
technical adoption sample, and the maintainer-resilience record. The project
has one named maintainer, no verified independent backup, no approved funding,
and no measured numeric quarterly commitment. Work starts only when the named
maintainer explicitly accepts it.

## Evidence gates

| Gate                             | Decision carried into this charter    | Limitation retained                                                                                               |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Strategy/privacy/security review | `oss-only-no-new-boundary`            | Documented resource, Action, adapter, and release gaps remain; no hosted collection is authorized.                |
| ADR 0007                         | `local-first-oss-stewardship`         | A new hosted, account, or team direction needs a public RFC and separate ADR.                                     |
| Sustainability/cost model        | `local-first-capacity-gated`          | Ranges are planning assumptions, not invoices, funding approval, or measured capacity.                            |
| Year 1–3 claims audit            | `defer-expansion`                     | 15 claims are verified, while partial, unsupported, negative, not-observed, and deferred results remain explicit. |
| Adoption evaluation              | `technical-sample-not-adoption`       | Three pinned public records are not representative adoption, certification, accuracy, or support evidence.        |
| Maintainer resilience            | `documented-routes-unverified-backup` | Public routes and synthetic rehearsals do not establish independent staffing or succession.                       |

The machine-readable strategy, sustainability, claims, and adoption decisions
are bound to their prior fixture digests. A changed strategy, claims,
sustainability, adoption, or ownership record requires this charter to be
refreshed before it can guide expansion.

## Outcomes and quarter stops

All four outcomes are `maintenance-only` and owned by `@AlisinaDevelo`:

1. Local core continuity and compatibility-preserving fixes.
2. Security, dependency, workflow, release-rehearsal, and hosted-fixture
   maintenance without claiming hosted check success.
3. Reproducible public evidence, schemas, fixtures, provenance, and links.
4. Public onboarding and handoff routes, with an independent rehearsal only
   when a real contributor is available.

The quarter plan is deliberately narrow:

| Quarter                       | Maintenance objective                                                   | Stop conditions                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Year 4 Q1 (Aug–Oct 2029)      | Preserve local core and security/dependency gates.                      | No accepted capacity; stale strategy/security/sustainability/claims gate; or a feature requiring a new authority boundary.      |
| Year 4 Q2 (Nov 2029–Jan 2030) | Maintain offline evidence and documentation replay.                     | No capacity; unknown or partial results being promoted into claims; or a federation proposal that cannot stay local-only.       |
| Year 4 Q3 (Feb–Apr 2030)      | Review ownership and public handoff routes.                             | No independent acknowledgement; owner gap in security/release/adapters; or a hosted team-history/support requirement.           |
| Year 4 Q4 (May–Jul 2030)      | Renew, narrow, transfer, or sunset the charter from refreshed evidence. | No refreshed gates; no funding or staffed owner; or any new boundary without RFC, privacy/security review, cost model, and ADR. |

Without explicit capacity and refreshed evidence, the project pauses or narrows
maintenance; it does not auto-start Year 4 expansion.

## Risks and non-goals

Open risks are the single-maintainer boundary, recurring hosted check ceilings,
unverified adoption and traction, unsupported-claim drift, and scope or release
creep. Mitigations are public routes, explicit local gates, digest-bound
evidence, private security intake, and fail-closed promotion/release decisions.

This charter does not authorize a hosted analyzer, source storage, account,
tenant, team workspace, source upload, hidden telemetry, automatic collector,
funded team commitment, numeric staffing or support budget, certification,
formal compliance, representative adoption, broad Rust coverage, a public SLA,
or automatic Year 4 feature work. Local tests and synthetic rehearsals remain
local evidence; they are not independent staffing or hosted-check evidence.

Revisit this charter after a material strategy, security, sustainability,
claims, adoption, ownership, funding, or trust-boundary change. Any new trust
boundary starts with a public RFC and a separate reviewed ADR.
