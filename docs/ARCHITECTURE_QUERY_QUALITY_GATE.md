# Architecture-query quality and safety gate

Gate ID: `architecture-query-quality-gate-v0.1`

As of: 2026-08-25

Report digest: sha256:98889f681a404dc19f6300e43b566146949f95ba906a9210a4fd561a5eded339

Decision: narrow

Multi-repository decision: defer

## Scope

This is a local, deterministic, read-only gate for CARTOGRAPH's bounded
single-repository architecture-query and explanation contracts. It measures the
checked-in Q-003 query corpus, Q-004 impact corpus, and Q-005 explanation corpus.
It does not claim production-repository accuracy, external reviewer utility, or
multi-repository composition readiness.

The supported slice is explicit selectors, bounded traversal, evidence-linked
paths, impact explanations, metadata projections, and declared resource limits.
Source execution, network retrieval, source-body reporting, absolute-path
disclosure, unbounded traversal, workspace trust, and cross-repository identity
remain outside the gate.

## Thresholds and measurements

| Metric                     | Threshold |             Observed | Status |
| -------------------------- | --------: | -------------------: | ------ |
| Deterministic correctness  |    `== 1` |    `1` (14/14 cases) | pass   |
| Impact precision           | `>= 0.90` | `0.8888888888888888` | miss   |
| Impact recall              | `>= 0.85` |                  `1` | pass   |
| Explanation completeness   |    `== 1` |      `1` (5/5 cases) | pass   |
| Resource safety            |    `true` |               `true` | pass   |
| Malformed-input safety     |    `true` |               `true` | pass   |
| Path-leakage safety        |    `true` |               `true` | pass   |
| Reviewer task completion   | `>= 0.80` |   `0.75` (3/4 tasks) | miss   |
| Repeatability              |    `true` |               `true` | pass   |
| Multi-repository readiness |    `true` |              `false` | miss   |

The machine-readable source is
[`report.v0.1.json`](../test/fixtures/architecture-query-quality-gate/report.v0.1.json).
Run `npm run query:quality:validate` to validate its schema, evidence paths,
threshold statuses, reviewer-task denominator, public decision, and digest.

## Decision

Continue the deterministic, read-only query and explanation slice for one
bounded repository with explicit limits and visible uncertainty. Narrow impact
claims to review assistance: boundary-stop and unresolved-edge overreach must
remain visible, and a human must confirm results whenever the precision or
reviewer-task floor is missed.

Multi-repository composition is **deferred**. The current corpus has no
workspace identity, trust, missing-input, resource, or independent reviewer
replication evidence. A follow-up gate must measure those boundaries before
team-scale composition is described as supported.

## Limitations

- Q-004 precision is below the declared 0.90 floor because the corpus contains
  two declared overreach records.
- Reviewer tasks are repository-authored synthetic scenarios, not an external
  user study; one impact-overreach task remains partial.
- Whole-repository adapter and language-equivalence runs can hit the configured
  536870912-byte RSS ceiling. A bounded resource outcome is not a scale claim.
- This gate contains no source bodies, secrets, network fetches, or repository
  execution.
