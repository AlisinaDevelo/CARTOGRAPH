# Year 1–3 claims audit

M-011 audits the material claims made by the first three program years before
the conditional Year 4 work is allowed to proceed. A material claim is a
roadmap exit-gate assertion or a strategy-decision assertion; it is not every
sentence in every historical issue. The complete, versioned register is the
digest-bound [`audit.v0.1.json`](../test/fixtures/claims-audit/audit.v0.1.json),
validated offline with:

```sh
npm run claims-audit:validate
```

Audit ID: `claims-audit-year1-3-v0.1`; audit date: 2026-08-25.
Current audit digest: `sha256:9816d6bdc618f4c34113f44f02e080ca3e764bdf27df24f5cfa206406560e71f`

The register contains 32 claims: 10 from Year 1, 9 from Year 2, and 13 from
Year 3. It covers the five requested categories—capability, quality, privacy,
adoption, and maintenance—and maps every included claim to a checked-in
document, schema, fixture, validator, test, or release record. No source body,
private record, credential, network collection, or hidden telemetry is part of
the audit.

## Reading the status vocabulary

| Status         | Meaning                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `verified`     | The bounded statement is reproduced by the named local evidence and its validator.                          |
| `partial`      | Some evidence is present, but a hosted, scale, release, or generalization condition remains open.           |
| `unsupported`  | The broad statement has no supporting evidence and must not be presented as a capability or quality result. |
| `negative`     | The audit found the claimed outcome absent at this boundary.                                                |
| `not-observed` | The repository intentionally retains no defensible observation for the claim.                               |
| `deferred`     | A decision is explicitly postponed pending a later public gate.                                             |

The distinction matters: `not-observed` is not a measured zero, `negative` is
not a software failure, and `verified` never expands beyond the named slice or
fixture. Non-verified claims are linked to at least one conditional Year 4
charter entry.

## Claim register

| ID                                     | Year | Category    | Status       | Finding                                                                                                  | Reproduce with                                            | Year 4 feed                                                                         |
| -------------------------------------- | ---: | ----------- | ------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `y1-capability-graph`                  |    1 | capability  | verified     | Bounded TypeScript/Express graphs are deterministic and source-evidenced.                                | `npm run check`                                           | —                                                                                   |
| `y1-capability-diff`                   |    1 | capability  | verified     | Semantic diff categories, identity ambiguity, and evidence are covered by golden tests.                  | `npx vitest run test/core/graph-diff.test.ts`             | —                                                                                   |
| `y1-capability-action`                 |    1 | capability  | partial      | The read-only fork boundary is locally enforced; hosted fixture jobs still miss `dist/cli.js`.           | `npm run action:validate`                                 | `year4-correctness-scale`                                                           |
| `y1-capability-distribution`           |    1 | capability  | partial      | Local package/SBOM/provenance and rollback rehearsals pass; no public release series exists.             | `npm run release:validate`                                | `year4-replication-stewardship`                                                     |
| `y1-quality-fixture-thresholds`        |    1 | quality     | verified     | Declared supported fixtures meet the local precision/recall/evidence gate.                               | `npm run check`                                           | —                                                                                   |
| `y1-quality-unsupported-diagnostics`   |    1 | quality     | verified     | Unsupported and unresolved constructs remain explicit diagnostics.                                       | `npm run support:validate`                                | —                                                                                   |
| `y1-privacy-local-boundary`            |    1 | privacy     | verified     | The analyzer is local-first without source upload, hidden telemetry, or a required network path.         | `npm run strategy-security:validate`                      | `year4-offline-composition`                                                         |
| `y1-maintenance-support-window`        |    1 | maintenance | partial      | Support and upgrade contracts are validated, but hosted runner ceilings remain open.                     | `npm run upgrade:validate`                                | `year4-correctness-scale`, `year4-replication-stewardship`                          |
| `y1-adoption-external-sample`          |    1 | adoption    | partial      | Three analyzed repositories and two bounded failures form a technical sample, not adoption evidence.     | `npm run compatibility:validate`                          | `year4-correctness-scale`, `year4-replication-stewardship`                          |
| `y1-adoption-traction`                 |    1 | adoption    | not-observed | No consented external contributor, adopter, retention, release, or usage series is retained.             | `npm run oss-health:validate`                             | `year4-replication-stewardship`                                                     |
| `y2-capability-identity`               |    2 | capability  | verified     | Supported moves and refactors preserve identity conservatively.                                          | `npm run identity:quality:validate`                       | —                                                                                   |
| `y2-capability-policy`                 |    2 | capability  | verified     | Bounded informational and enforcing local policy modes are validated.                                    | `npm run policy:validate`                                 | `year4-governed-review`                                                             |
| `y2-capability-adr`                    |    2 | capability  | verified     | ADR references, lifecycle, coverage, and drift are checked locally.                                      | `npm run adr:validate`                                    | `year4-governed-review`                                                             |
| `y2-capability-adapter-contract`       |    2 | capability  | verified     | Adapter negotiation, starter, support, lifecycle, and isolation contracts pass.                          | `npm run adapter:validate`                                | `year4-governed-review`                                                             |
| `y2-quality-identity-baseline`         |    2 | quality     | verified     | The identity quality digest and bounded thresholds pass.                                                 | `npm run identity:quality:validate`                       | —                                                                                   |
| `y2-quality-policy-regression`         |    2 | quality     | verified     | Policy false-positive, false-negative, explanation, and evidence baselines remain zero.                  | `npm run policy-regression:validate`                      | `year4-governed-review`                                                             |
| `y2-privacy-adapter-isolation`         |    2 | privacy     | verified     | Untrusted adapters are isolated or refused with bounded permissions and resources.                       | `npm run adapter:validate`                                | `year4-offline-composition`                                                         |
| `y2-maintenance-ownership`             |    2 | maintenance | partial      | Ownership and security/update procedures exist, but no SLA or succession evidence exists.                | `npm run check`                                           | `year4-governed-review`, `year4-replication-stewardship`                            |
| `y2-adoption-contributors`             |    2 | adoption    | not-observed | No repeat non-maintainer contributor records are retained.                                               | `npm run community-feedback:validate`                     | `year4-replication-stewardship`                                                     |
| `y3-capability-rust-pilot`             |    3 | capability  | verified     | The narrow Rust pilot records 9/9 supported edges and explicit dynamic diagnostics.                      | `npm run language-expansion:validate`                     | —                                                                                   |
| `y3-capability-language-expansion`     |    3 | capability  | deferred     | The pilot remains experimental; broad Rust expansion is deferred.                                        | `npm run language-expansion:validate`                     | `year4-correctness-scale`, `year4-replication-stewardship`                          |
| `y3-quality-broad-rust-accuracy`       |    3 | quality     | unsupported  | No evidence supports accuracy for broad Rust programs or constructs.                                     | `npm run language-expansion:validate`                     | `year4-correctness-scale`, `year4-replication-stewardship`                          |
| `y3-capability-runtime-reconciliation` |    3 | capability  | partial      | Local synthetic reconciliation, redaction, uncertainty, and bounds pass; no live collector is claimed.   | `npm run runtime-reconciliation:corpus:validate`          | `year4-offline-composition`, `year4-correctness-scale`                              |
| `y3-quality-runtime-reproducibility`   |    3 | quality     | partial      | Twenty synthetic replay digests are stable under selected perturbations; production variance is unknown. | `npm run runtime-reconciliation:reproducibility:validate` | `year4-correctness-scale`, `year4-offline-composition`                              |
| `y3-quality-compatibility-sample`      |    3 | quality     | partial      | The five-repository review is reproducible but not representative accuracy evidence.                     | `npm run compatibility:validate`                          | `year4-correctness-scale`, `year4-replication-stewardship`                          |
| `y3-capability-community-feedback`     |    3 | capability  | verified     | The consented public feedback and RFC decision loop is contract-tested.                                  | `npm run community-feedback:validate`                     | `year4-governed-review`                                                             |
| `y3-privacy-strategy-boundary`         |    3 | privacy     | verified     | M-009 accepts OSS-only local-first scope and binds the privacy/security review to ADR 0007.              | `npm run strategy-security:validate`                      | `year4-offline-composition`, `year4-governed-review`                                |
| `y3-adoption-external-feedback`        |    3 | adoption    | not-observed | The snapshot contains one synthetic maintainer baseline and zero external records.                       | `npm run community-feedback:validate`                     | `year4-replication-stewardship`                                                     |
| `y3-maintenance-release-history`       |    3 | maintenance | negative     | No public package release series exists; local artifact rehearsal is not a release history.              | `npm run oss-health:validate`                             | `year4-replication-stewardship`                                                     |
| `y3-maintenance-capacity`              |    3 | maintenance | not-observed | One named maintainer and a cadence are documented, but load and succession are unmeasured.               | `npm run oss-health:validate`                             | `year4-governed-review`, `year4-replication-stewardship`                            |
| `y3-quality-oss-hardening`             |    3 | quality     | partial      | Local budgets, security, upgrade, compatibility, and docs gates pass; external scale remains open.       | `npm run check`                                           | `year4-correctness-scale`, `year4-governed-review`, `year4-replication-stewardship` |
| `y3-privacy-hosted-expansion`          |    3 | privacy     | deferred     | Hosted, account, source-upload, and hidden-collection expansion is not authorized by backlog completion. | `npm run adr:validate`                                    | `year4-offline-composition`, `year4-governed-review`                                |

## Summary

| Measure                                                 |             Result |
| ------------------------------------------------------- | -----------------: |
| Claims                                                  |                 32 |
| Year 1 / Year 2 / Year 3                                |        10 / 9 / 13 |
| Capability / quality / privacy / adoption / maintenance | 12 / 8 / 4 / 4 / 4 |
| Verified                                                |                 15 |
| Partial                                                 |                  9 |
| Unsupported                                             |                  1 |
| Negative                                                |                  1 |
| Not observed                                            |                  4 |
| Deferred                                                |                  2 |

The status distribution is the result: 17 of 32 claims are not fully verified
for their broad wording. The audit therefore does not authorize a hosted
service, a team workspace, a public traction claim, broad Rust support, or a
release-stability claim.

## Year 4 charter feed

The register feeds four conditional Year 4 tracks. These are sequencing
guards, not permission to expand the trust boundary.

| Track                       | Action                                                                                                                        | Gate                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness and scale       | Repair hosted Action artifact assembly, preserve unsupported outcomes, and add representative local scale fixtures.           | New scale or language claims need positive, negative, ambiguity, resource, and independent-comparison evidence.                              |
| Offline composition         | Keep snapshots, traces, policies, and reports local and separately provenance-bound.                                          | Hosted or account-bearing proposals need a public RFC, privacy/security review, cost model, and ADR.                                         |
| Governed review             | Prioritize ownership, expiry-bound decisions, security response, upgrade rehearsals, and maintainer-load/succession evidence. | Team-scale governance needs named ownership, replayable evidence, and a capacity-backed support decision.                                    |
| Replication and stewardship | Collect only public or consented aggregate evidence for releases, adopters, contributors, comparisons, and support load.      | A strategy refresh must publish denominators, sampling limits, negative results, and reproducible evidence before traction or market claims. |

The machine-readable charter fixes `investmentDecision` to
`conditional-maintenance-first` and `hostedExpansion` to `deferred`. Any
materially different direction must start with a public RFC and a separately
reviewed ADR.

## Evidence boundary and refresh trigger

The audit is intentionally reproducible from local repository state. It stores
claim text, status, evidence paths, commands, limitations, and digests—not
third-party source, private messages, credentials, telemetry, or a hidden
collector. Refresh it when a Year 1–3 source contract changes, a release or
public compatibility sample is added, a consented aggregate feedback record is
accepted, or a public strategy proposal changes the trust boundary.
