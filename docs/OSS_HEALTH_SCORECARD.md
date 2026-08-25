# OSS health and traction scorecard

M-005 publishes a small, aggregate-only scorecard for deciding whether future
hosted or team investment has earned evidence. It is a measurement protocol,
not a usage-telemetry system. The current snapshot is the versioned
[`scorecard.v0.1.json`](../test/fixtures/oss-health/scorecard.v0.1.json),
validated offline with:

```sh
npm run oss-health:validate
```

The [JSON Schema](../schema/oss-health-scorecard.v0.1.schema.json) requires a
public collection boundary, explicit limitations, both successful and bounded
failure runs, and a claim state for every dimension. `not-observed` means that
the project has not collected defensible evidence; it is not a measured zero.

## Current snapshot

As of 2026-08-25, the scorecard has one observed dimension and seven
not-observed dimensions:

| Dimension                           | Current state              | Evidence or limitation                                                                                                                               |
| ----------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successful external repository runs | 3 successful of 5 reviewed | The R-005 compatibility review names three analyzed public repositories and two bounded failures; this is a technical sample, not an adoption claim. |
| Repeat non-maintainer contributors  | Not observed               | No consented external contributor records are retained.                                                                                              |
| Release stability                   | Not observed               | No public package release exists; local rehearsal is not a release series.                                                                           |
| Issue quality                       | Not observed               | The public rubric exists, but no sampled quality series has been collected.                                                                          |
| Maintainer load                     | Not observed               | No maintainer-time or support telemetry is collected.                                                                                                |
| Security history                    | Not observed               | The policy and threat model are public, but this snapshot does not claim a complete incident census or zero incidents.                               |
| Retention or feedback               | Not observed               | The M-004 snapshot has zero external feedback records.                                                                                               |
| Adopter feedback coverage           | Not observed               | The current record is a synthetic maintainer baseline, not user research.                                                                            |

The five compatibility records are aggregate-only pointers to public
repositories and short revisions. CARTOGRAPH does not check third-party source
into this repository, retain graph snapshots, or treat a successful run as
evidence of representative accuracy or adoption. The bounded failures remain
in the denominator so the sample cannot be presented as a success-only list.

## Collection protocol

Only manually reviewed public or explicitly authorized evidence may enter a
future snapshot:

- public compatibility reports, issues, pull requests, and discussions;
- release artifacts and their local checksums or smoke-test records;
- public security advisories and reviewed maintainer records; and
- consented, anonymized adopter or contributor summaries from the
  [community feedback contract](COMMUNITY_FEEDBACK.md).

The contract prohibits network collection, hidden telemetry, source upload,
personal data, and retention of raw source or private messages. A summary keeps
the evidence references, aggregate values, limitations, and decision state;
raw material is not a scorecard input. Public issue volume, stars, downloads,
GitHub views, and CI runs are weak signals and never become traction claims by
themselves.

## Strategy guard

The current scorecard explicitly defers both traction claims and hosted
investment. The three successful compatibility runs establish only that a
bounded public technical sample was exercised. Representative external
retention or feedback, repeat non-maintainer contributions, public release
stability, issue quality, maintainer capacity, and security-history evidence
remain unobserved. Later work must publish those dimensions with sampling bias,
consent, retention, and deletion responsibilities before a strategy ADR can
authorize expansion.

The scorecard does not create an account, hosted service, source-ingestion
path, or background collector. Its evidence remains reviewable in the
repository and can be recomputed without contacting an exporter.
