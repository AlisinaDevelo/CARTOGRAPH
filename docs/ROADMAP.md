# Three-year roadmap

Quarter names are sequence labels, not calendar or delivery commitments. Each milestone has an exit gate. If an expansion gate fails, the project spends the quarter on correctness, compatibility, documentation, or maintenance instead of adding scope.

The detailed work lives in GitHub issues. This document explains the intended outcomes and stop conditions.

## Year 1: prove the local review loop

### Q1 — Contracts and safe foundation

A contributor can install CARTOGRAPH, inspect the graph and evidence contract, and run a deterministic fixture scan.

Exit gate: schema and evidence invariants are tested; the threat model is public; offline behavior is verified; clean-install CI passes.

### Q2 — TypeScript and Express extraction

Bounded TypeScript and Express repositories produce useful graphs with honest unsupported diagnostics.

Exit gate: at least five curated fixtures; complete evidence on emitted edges; precision and recall reported by construct family; no silent dynamic edges.

### Q3 — Reviewable revisions

A maintainer can compare two revisions and inspect a self-contained static report.

Exit gate: versioned JSON diff; golden mutation tests; offline HTML report; documented CLI and exit behavior; initial performance baseline.

### Q4 — CI and v0.1 adoption

A repository can run CARTOGRAPH in a read-only GitHub Action and install a reproducible OSS release.

Exit gate: fork-safe Action smoke test; three representative repository reports; package-install smoke test; quickstart and compatibility report; security review.

## Year 2: add durable architecture control

### Q1 — Refactor-stable identity

Ordinary line moves, file moves, and supported renames no longer appear as unrelated architecture objects.

Exit gate: identity rules and ambiguity behavior documented; rename and move fixtures pass; snapshot migration path exists.

### Q2 — Change-control policies

Teams can express bounded graph constraints and choose informational or enforcing CI behavior.

Exit gate: versioned local policy schema; deterministic evidence-linked violations; stable exit modes; measured false-positive fixtures; no remote policy dependency.

### Q3 — Decision traceability

Local architecture decisions can be linked to graph objects and reviewed beside changed evidence.

Exit gate: stale and missing references detected; reports show decision status and evidence; workflow remains usable without a service.

### Q4 — Extension contract

External contributors can implement an adapter without changing the core. A second TypeScript framework proceeds only after a public selection RFC.

Exit gate: adapter API, capability manifest, conformance kit, and support matrix are public; any new adapter meets the same quality gates.

## Year 3: validate expansion, runtime evidence, and sustainability

### Q1 — Language expansion gate

CARTOGRAPH validates one bounded non-TypeScript adapter or records why language expansion should be deferred.

Exit gate: language-neutral mapping contract tested; any pilot publishes conformance and unsupported coverage; no broad language claim.

### Q2 — Runtime reconciliation experiment

Users can optionally reconcile local OpenTelemetry observations with static edges without a hosted collector.

Exit gate: local versioned input; deterministic classifications; synthetic-trace evaluation; secret and payload redaction tests; explicit opt-in.

### Q3 — OSS hardening and community scale

Larger repositories and new contributors receive predictable performance, security, upgrade, and support behavior.

Exit gate: performance budgets; bounded fuzz/property suite; compatibility and deprecation policy; public adopter-feedback summary.

### Q4 — Traction-based strategy gate

The project chooses its next investment from evidence instead of assuming a hosted product is warranted.

Exit gate: public OSS health scorecard and decision ADR. Hosted discovery requires explicit adoption, retention, privacy, and security gates; otherwise the roadmap remains OSS-focused.

## Measures that do not decide the roadmap alone

Stars, downloads, graph size, and waitlist emails are weak signals. The strategy gate weighs successful external repository runs, repeat users, non-maintainer contributions, release stability, issue quality, security history, reviewer usefulness, and maintainer load.
