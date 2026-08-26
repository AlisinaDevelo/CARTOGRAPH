# Five-year roadmap

CARTOGRAPH is planned as 20 dated rolling quarters from August 2026 through July 2031. The managed [roadmap manifest](../roadmap/manifest.json) contains 179 outcome-bearing issues and 514 explicit prerequisite relationships. Every issue has a problem/outcome, measurable acceptance criteria, labels, priority, milestone, and an evidence-based place in the dependency graph.

Later work is conditional. When an exit gate fails, the next quarter is spent on correctness, compatibility, security, documentation, or maintenance rather than treating backlog completion as permission to expand.

| Program year | Managed issues | Primary decision                                                                                      |
| ------------ | -------------: | ----------------------------------------------------------------------------------------------------- |
| Year 1       |             38 | Prove a trustworthy local TypeScript/Express review loop and v0.1 distribution path.                  |
| Year 2       |             30 | Make identity, policy, ADR traceability, and adapter boundaries durable.                              |
| Year 3       |             32 | Validate bounded expansion, runtime evidence, OSS health, and the local-first investment boundary.    |
| Year 4       |             42 | Add conditional workspace-scale queries, offline composition, governed review, and assurance bundles. |
| Year 5       |             37 | Validate history, remediation, ecosystem claims, LTS stewardship, and the next-horizon decision.      |

## Program outcomes

- **Year 1 — Trustworthy local review:** ship a deterministic TypeScript/Express graph, evidence-backed diff, static report, read-only CI path, and reproducible v0.1 release.
- **Year 2 — Durable architecture control:** make identity survive supported refactors, add explainable local policies and ADR traceability, and establish a safe adapter contract.
- **Year 3 — Evidence-based expansion:** test a bounded language adapter and runtime reconciliation, harden the OSS project, and make an explicit strategy and sustainability decision.
- **Year 4 — Conditional team-scale assurance:** add bounded impact queries, offline multi-repository composition, governed ownership and waivers, and reproducible evidence packs only if the Year 3 gates authorize the investment.
- **Year 5 — Durable intelligence and stewardship:** validate longitudinal trends and remediation assistance, publish independent research evidence, cut an LTS line, and choose a funded next horizon or safe sunset.

## Year 1 — Trustworthy local review

### Q1 — Contracts and safe foundation

A contributor can install CARTOGRAPH, inspect the graph and evidence contract, and run a deterministic fixture scan.

Exit gate: schema and evidence invariants are tested; the threat model is public; resource ceilings and offline behavior are verified; clean-install CI passes.

### Q2 — TypeScript and Express extraction

Bounded TypeScript and Express repositories produce useful graphs with honest unsupported diagnostics.

Exit gate: at least five curated fixtures; complete evidence on emitted edges; precision and recall reported by construct family; no silent dynamic edges.

### Q3 — Reviewable revisions

A maintainer can compare two revisions and inspect a self-contained static report.

Exit gate: versioned JSON diff; golden mutation tests; offline HTML report; documented CLI and exit behavior; deterministic benchmark baseline.

### Q4 — CI and v0.1 adoption

A repository can run CARTOGRAPH in a read-only GitHub Action and install a reproducible OSS release.

Exit gate: fork-safe Action smoke test; representative repository reports; package-install and rollback rehearsal; quickstart, compatibility, and security review.

## Year 2 — Durable architecture control

### Q1 — Refactor-stable identity

Ordinary line moves, file moves, and supported renames no longer appear as unrelated architecture objects.

Exit gate: identity and ambiguity rules, portability fixtures, migration tooling, property-based corpus, and measured false-match and preservation thresholds pass.

### Q2 — Change-control policies

Teams can express bounded graph constraints and choose informational or enforcing CI behavior.

Exit gate: versioned local policy schema; deterministic evidence-linked violations; explicit composition and precedence; expiry-bound exceptions; measured false-positive fixtures.

### Q3 — ADR traceability

Local architecture decisions can be linked to graph objects and reviewed beside changed evidence.

Exit gate: lifecycle and supersession semantics; stale and missing references; reverse coverage indexes; policy/decision drift evaluation; fully local workflow.

### Q4 — Extension contract

External contributors can implement an adapter without changing the core, and a second TypeScript framework proceeds only after a public selection RFC.

Exit gate: adapter API, capability negotiation, isolation budgets, conformance kit, starter, support matrix, review playbook, and ownership policy are public.

## Year 3 — Evidence-based expansion

### Q1 — Language expansion gate

CARTOGRAPH validates one bounded non-TypeScript adapter or records why language expansion should be deferred.

Exit gate: language-neutral mapping, cross-language equivalence corpus, conformance and unsupported coverage, maintenance/security ownership, and a graduate, narrow, or retire ADR.

The completed gate is recorded in the [language-expansion report](LANGUAGE_EXPANSION_GATE.md)
and [ADR 0006](adr/0006-language-expansion-gate.md): the bounded Rust pilot is
retained as experimental while broad Rust expansion remains deferred.

### Q2 — Runtime reconciliation experiment

Users can optionally reconcile local OpenTelemetry observations with static edges without a hosted collector.

Exit gate: versioned local input; deterministic classifications; sampling and uncertainty semantics; synthetic evaluation; redaction and retention controls; bounded offline CLI/report integration.

### Q3 — OSS hardening and community scale

Larger repositories and new contributors receive predictable performance, security, upgrade, and support behavior.

Exit gate: performance budgets; bounded fuzz/property suites; automated compatibility matrix; maintenance policy; adopter feedback; and the [maintainer resilience and onboarding report](MAINTAINER_RESILIENCE.md) with explicit backup paths, two non-author role rehearsals, and published unresolved bus-factor risks.

### Q4 — Traction-based strategy gate

The project chooses its next investment from evidence instead of assuming a hosted or team product is warranted.

Exit gate: the [OSS health scorecard](OSS_HEALTH_SCORECARD.md), [repository adoption evaluation](ADOPTION_EVALUATION.md), [telemetry-free adoption measurement](ADOPTION_MEASUREMENT.md), [Year 1–3 claims audit](CLAIMS_AUDIT.md), [strategy-branch privacy and security review](STRATEGY_PRIVACY_SECURITY_REVIEW.md), [ADR 0007](adr/0007-local-first-investment-boundary.md), [sustainability and cost model](SUSTAINABILITY_COST_MODEL.md), and the [conditional Year 4 investment charter](YEAR4_INVESTMENT_CHARTER.md). M-012 selects a capacity-gated maintenance track; without refreshed evidence and explicit capacity, expansion remains deferred.

## Year 4 — Conditional team-scale assurance

### Q1 — Bounded queries and workspace scale

Reviewers can answer bounded architecture questions and inspect why a change may affect supported paths, controls, decisions, or owners.

Exit gate: versioned query contract; deterministic reachability; impact scenarios with precision/recall; evidence-linked explanations; resource, security, and reviewer-utility gate.

### Q2 — Offline multi-repository composition

Teams can compose independently produced snapshots into an offline portfolio without uploading source.

Exit gate: workspace manifest; cross-repository identity and boundary contracts; provenance-aware incremental recomposition; privacy/resource controls; and the [representative federation evaluation](WORKSPACE_FEDERATION_EVALUATION.md).

### Q3 — Governed review and interoperability

Architecture findings have explicit owners, lifecycle states, expiry-bound signed exceptions, and auditable local history.

Exit gate: deterministic ownership resolution; the local [auditable finding lifecycle](FINDING_LIFECYCLE.md); [waiver verification](ARCHITECTURE_WAIVERS.md) and [ownership/waiver drift detection](OWNERSHIP_WAIVER_DRIFT.md); the bounded [review-summary contract](../schema/review-summary.v0.1.schema.json), [patch-scoped graph and policy filter](PATCH_FILTER.md), and fork-safe Action output; the bounded [SCIP interchange contract](SCIP_INTERCHANGE.md); and the [review workflow usability, integrity, and load evaluation](REVIEW_WORKFLOW_EVALUATION.md).

### Q4 — Reproducible assurance bundles

Organizations can export a bounded, reproducible assurance bundle that explains architecture controls without claiming formal compliance.

Exit gate: canonical bundle contract; signed manifest and provenance; SBOM linkage; scoped control/evidence mapping; redaction controls; independent offline replay.

## Year 5 — Durable intelligence and stewardship

### Q1 — Longitudinal architecture intelligence

Maintainers can measure architecture evolution and debt trends without hidden telemetry or misleading forecasts.

Exit gate: versioned local history store; reproducible metrics; explicit gaps and baseline changes; transparent debt signals; retention/compaction controls; longitudinal validity and scale evaluation.

### Q2 — Governed remediation and policy portability

CARTOGRAPH can propose bounded, evidence-backed remediation plans while edits and enforcement remain under human control.

Exit gate: versioned suggestion contract; deterministic rules; isolated patch preview and validation; explicit model-provider privacy boundary; human approval workflow; red-team and utility gate.

### Q3 — Ecosystem and research validation

Core claims are tested against external tools, portable formats, public corpora, and independent reviewers.

Exit gate: governed replication corpus; transparent comparative benchmark; loss-aware ecosystem mappings; independent replication; published negative results and limitations; explicit standards/research decision.

### Q4 — LTS sustainability and strategy renewal

The project enters its next cycle with an evidence-based support model, succession plan, and terminal investment decision.

Exit gate: reproducible LTS release; migration/recovery rehearsal; security and reproducibility audit; maintainer continuity; five-year technical, market, and research retrospective; continue, scale, transfer, maintain, or sunset ADR.

## Measures that do not decide the roadmap alone

Stars, downloads, graph size, issue count, and waitlist emails are weak signals. Gates weigh successful external repository runs, correctness and unknown coverage, repeat users, non-maintainer contributions, release stability, security history, reviewer usefulness, support load, maintenance cost, research replication, and credible funding or stewardship.
