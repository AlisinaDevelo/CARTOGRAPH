# Repository adoption evaluation

R-017 publishes a reproducible template for evaluating public repositories
without turning a compatibility sample into an adoption, certification, or
support claim. The machine-readable report is
[`report.v0.1.json`](../test/fixtures/adoption-evaluation/report.v0.1.json),
its contract is
[`adoption-evaluation.v0.1.schema.json`](../schema/adoption-evaluation.v0.1.schema.json),
and the offline replay command is:

```sh
npm run adoption-evaluation:validate
```

## What is replayable

The report replays three successful R-005 public-repository records at pinned
source revisions. Replay validates the aggregate record, source revision,
tool revision, snapshot digest, counts, limitations, and no-collection
boundary. It does not fetch a repository or rerun a live scan. A future live
run must use an explicitly authorized public checkout and must not retain
source, credentials, hidden telemetry, or user data.

| Repository                                                  | Pinned source revision |         Aggregate graph | Unknown diagnostics | Size / timing / reviewer usefulness |
| ----------------------------------------------------------- | ---------------------- | ----------------------: | ------------------: | ----------------------------------- |
| [honojs/hono](https://github.com/honojs/hono)               | `017000d`              | 802 nodes / 1,186 edges |                 392 | Not observed                        |
| [microsoft/tsyringe](https://github.com/microsoft/tsyringe) | `e033769`              |   102 nodes / 225 edges |                  30 | Not observed                        |
| [pmndrs/zustand](https://github.com/pmndrs/zustand)         | `b57db4f`              |   219 nodes / 145 edges |               2,721 | Not observed                        |

The template records repository URL and license, pinned source and tool
revisions, selected tsconfig, observed language, framework status, graph and
unknown counts, snapshot digest, timing status, reviewer-usefulness status,
feedback, limitations, and the exact offline replay fixture. Repository byte
or file size, scan duration, framework inventory, and external reviewer
usefulness are deliberately `not-observed` in this snapshot; no value is
silently treated as zero.

## Interpretation boundary

The three rows are a technical compatibility sample, not evidence of market
adoption, representative accuracy, certification, a support guarantee, or
population-wide precision and recall. Unknown diagnostics remain visible, and
Zustand's high unresolved-call count is retained as a negative result. The
report contains public repository metadata and aggregate analyzer results only;
it does not redistribute third-party source, source excerpts, or graph
snapshots.

The method is local and deterministic (`network: false`, no credentials, no
hidden telemetry, no user data). Any future addition of live repository runs,
external reviewer records, or adoption feedback needs a new report revision
with sampling, consent, retention, and deletion responsibilities documented.
