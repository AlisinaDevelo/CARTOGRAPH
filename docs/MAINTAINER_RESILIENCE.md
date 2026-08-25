# Maintainer resilience and onboarding

This document is the public M-008 ownership and continuity record. It makes the
current single-maintainer boundary explicit and gives a contributor a bounded
route through triage, release, security, core contracts, adapters, and roadmap
operations. It is an operational map, not a response-time, support, or release
promise.

The machine-readable source is
[`test/fixtures/maintainer-resilience/report.v0.1.json`](../test/fixtures/maintainer-resilience/report.v0.1.json),
validated against
[`schema/maintainer-resilience.v0.1.schema.json`](../schema/maintainer-resilience.v0.1.schema.json)
with:

```sh
npm run maintainer-resilience:validate
```

The snapshot is `maintainer-resilience-year3-q3-v0.1`, as of
2026-08-25T16:00:00Z. It is public-only, local, offline, and digest-oriented.
It contains no contributor identities, private reports, source bodies, network
traces, hosted-check results, credentials, or hidden telemetry.

## Ownership and backup paths

`@AlisinaDevelo` is the only current named maintainer in this snapshot. Every
role has a documented backup path, but all six paths are
`documented-unverified`: the repository has not observed a staffed independent
backup. A route is a safe handoff and escalation procedure; it is not evidence
that another person has accepted repository access or release authority.

| Role                              | Current owner    | Backup path                                                                                                                           | Staffing status |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Triage                            | `@AlisinaDevelo` | Public taxonomy and issue-template handoff in [`COMMUNITY_FEEDBACK.md`](COMMUNITY_FEEDBACK.md#triage-taxonomy)                        | Unverified      |
| Release and rollback              | `@AlisinaDevelo` | Versioned no-go and rollback record in [`RELEASE_REHEARSAL.md`](RELEASE_REHEARSAL.md)                                                 | Unverified      |
| Security intake                   | `@AlisinaDevelo` | Private vulnerability reporting or the private profile fallback in [`SECURITY.md`](../SECURITY.md#reporting-a-vulnerability)          | Unverified      |
| Core graph/evidence/CLI contracts | `@AlisinaDevelo` | Public RFC and second-reviewer assignment through [`GOVERNANCE.md`](../GOVERNANCE.md)                                                 | Unverified      |
| Adapter ownership                 | `@AlisinaDevelo` | Freeze promotion, replay lifecycle evidence, and route a migration through [`ADAPTER_RETIREMENT.md`](ADAPTER_RETIREMENT.md#ownership) | Unverified      |
| Roadmap and evidence operations   | `@AlisinaDevelo` | Dependency-aware public issue and merged-main evidence in [`ROADMAP.md`](ROADMAP.md)                                                  | Unverified      |

The role map does not grant permissions. Material contract, privacy, security,
adapter, language, or workflow changes still require the public RFC process;
release authority remains protected by the release gate; and security reports
never use a public issue.

## Onboarding map

Each role has two checked-in onboarding steps in the fixture. The shortest safe
common path is:

1. Read [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`MAINTENANCE.md`](MAINTENANCE.md),
   and the relevant role documents.
2. Install with lifecycle scripts disabled and run the local gate:
   `npm ci --ignore-scripts` followed by `npm run check`.
3. Keep fixtures synthetic and changes local; do not process source or data that
   the operator is not authorized to inspect.
4. Link the exact commands, toolchain, limitations, and merged SHA in the issue
   and pull request before a roadmap item is closed.

Role-specific entry points are:

- **Triage:** [`COMMUNITY_FEEDBACK.md`](COMMUNITY_FEEDBACK.md) and the bug,
  feature, and RFC templates. Ask for a minimal sanitized reproduction and
  classify the report before suggesting a roadmap change.
- **Release:** [`RELEASE.md`](RELEASE.md) and
  [`RELEASE_REHEARSAL.md`](RELEASE_REHEARSAL.md). A failed gate is a no-go;
  the rehearsal does not create a tag or edit a release.
- **Security:** [`SECURITY.md`](../SECURITY.md) and the
  [`THREAT_MODEL.md`](THREAT_MODEL.md). Use private intake and synthetic or
  redacted reproductions only.
- **Core contracts:** [`ARCHITECTURE.md`](ARCHITECTURE.md),
  [`CHANGE_CONTROL.md`](CHANGE_CONTROL.md), and the RFC process. Preserve
  deterministic fixtures, compatibility evidence, and explicit unsupported
  behavior.
- **Adapters:** [`ADAPTER_REVIEW_PLAYBOOK.md`](ADAPTER_REVIEW_PLAYBOOK.md),
  [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), and
  [`ADAPTER_RETIREMENT.md`](ADAPTER_RETIREMENT.md). Owner gaps freeze promotion
  rather than silently widening support claims.
- **Roadmap operations:** [`ROADMAP.md`](ROADMAP.md),
  [`roadmap/manifest.json`](../roadmap/manifest.json), and
  [`GOVERNANCE.md`](../GOVERNANCE.md). Dependencies, acceptance criteria, and
  evidence remain machine-readable and reviewable.

## Non-author role rehearsals

Two local rehearsals completed from the same public instructions on the local
developer device:

| Rehearsal                    | Task                                                                              | Result | What it proves                                                                                                          | What it does not prove                                         |
| ---------------------------- | --------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `non-author-contributor`     | Formatting, lint, typecheck, and focused resilience test                          | Passed | A simulated contributor can discover and execute the bounded contribution path without a write or push                  | It is not an external contribution or a staffed reviewer       |
| `non-author-release-triager` | Offline compatibility, Action-fixture, documentation-link, and roadmap validators | Passed | A simulated release/triage operator can run the no-write preflight without a tag, issue, release, or network collection | It is not release authority or evidence that hosted checks ran |

The actor labels are deliberately synthetic non-author roles. No external person
or contributor identity is claimed. The rehearsals expose the remaining gap:
the route is reproducible, while independent acknowledgement and succession are
not observed.

Observed friction is limited to two facts: the supported LTS window remains
Node 22.x and 24.x even though this local rehearsal used compatible Node 26.7.0,
and hosted checks/GitHub mutations are outside the offline path. Neither fact is
converted into a support or adoption claim.

## Open continuity risks

The fixture keeps seven unresolved risks instead of turning documentation into a
false redundancy claim:

- triage, release, security, core-contract, and adapter ownership each remain a
  high-severity single-maintainer risk;
- roadmap operations remain maintainer-led even though the manifest is public;
  and
- the onboarding map has no independent human rehearsal or acknowledgement.

The mitigation is to preserve public routes, fail closed on owner gaps, require
focused evidence and second review for material changes, and repeat the
rehearsals with an actual non-author contributor when one is available. Until
then, M-008 reduces discovery friction but does not claim that the bus factor is
resolved.

## Verification boundary

The validator checks the six-role inventory, every authority and backup route,
role-specific onboarding references, two passed non-author task kinds, command
no-write/no-network restrictions, risk references, public-only scope, and
summary counts. It computes a stable digest for the fixture. A local pass is
retained as evidence when hosted Actions are unavailable; it is not a claim that
hosted checks passed.
