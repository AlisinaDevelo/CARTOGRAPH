# G-006 review workflow evaluation

The checked-in [`cartograph.review-workflow-evaluation`](../schema/review-workflow-evaluation.v0.1.schema.json)
record evaluates whether governed review output remains useful, bounded, and
recoverable without concentrating approval power. It is an aggregate-only local
replay; it is not a telemetry system, hosted workflow, or user study.

Run the replay with:

```sh
npm run review-workflow:evaluation:validate
```

The validator derives every measurement from the observation records, checks the
public decision against the derived result, and rejects absolute paths, remote
references, credentials, source bodies, mutative commands, and unbounded evidence.
The same report is safe to replay from a fork because it reads only checked-in
fixture data and has no network, execution, or write authority.

## Public gate

- Evaluation: `g006-v0.1`
- Decision: defer
- Security outcome: pass
- Report digest: sha256:077ff3d28894561fff3d8ff268a973c6e50d65c0da92200e603e9ca1e8b20a92
- Evidence basis: synthetic replay only

The seven measured dimensions are:

| Metric                     |      Derived result |    Threshold |
| -------------------------- | ------------------: | -----------: |
| `triage-accuracy`          |                1.00 |       ≥ 0.90 |
| `time-to-owner`            |    18,000 ms median |  ≤ 30,000 ms |
| `waiver-review-time`       |    45,000 ms median |  ≤ 90,000 ms |
| `stale-finding-rate`       |                0.50 |       ≤ 0.50 |
| `reviewer-task-completion` |                0.80 |       ≥ 0.80 |
| `maintainer-load`          | 13.5 minutes median | ≤ 20 minutes |
| `failure-recovery`         |                0.75 |       ≥ 0.75 |

The security review covers `forgery`, `replay`, `broad-waiver`,
`owner-spoofing`, `fork-pull-request`, and `compromised-key`. All six are
blocked by existing digest, expiry, ownership, signing, and fork-safe Action
controls. A blocked abuse case is not permission to automate an approval.

The decision is `defer` even though the synthetic thresholds pass: no
independent maintainer participated, and the record makes no production
usability, load, adoption, or team-scale approval claim. The allowed scope is
continued local, read-only review-summary and Action maintenance. Before a
broader workflow change, repeat the study with consented independent maintainers,
replay all six abuse cases, and compare failure recovery and load on representative
repositories while retaining aggregate-only evidence.

This report does not change GraphSnapshot, GraphDiff, review-summary, ownership,
waiver, signing, or Action wire contracts. It is governance evidence only; a
future change to metric meaning requires a new evaluation version or an explicit
compatibility review.
