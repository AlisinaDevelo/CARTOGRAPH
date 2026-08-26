# Workspace federation evaluation

W-006 publishes a deterministic, aggregate-only replay of three representative
portfolios. Run the checked-in report locally with:

```sh
npm run workspace:federation:evaluation:validate
```

The machine-readable report is
[`report.v0.1.json`](../test/fixtures/workspace-federation-evaluation/report.v0.1.json)
and its reviewed contract is
[`workspace-federation-evaluation.v0.1.schema.json`](../schema/workspace-federation-evaluation.v0.1.schema.json).

## Replayed scope

All three records are sanitized and pinned. None of the replays fetches a
repository, opens a source body, executes a package manager, or contacts a
network. Every portfolio declares a size tier and includes package, service,
schema, missing-repository, version-skew, and cross-boundary-change scenarios.
Missing and mismatched inputs remain explicit unresolved outcomes.

| Portfolio     | Size tier | Repositories | Nodes / edges | Resolution precision / recall | Unknown rate | Identity stability | Warm speedup |
| ------------- | --------- | -----------: | ------------: | ----------------------------: | -----------: | -----------------: | -----------: |
| Atlas         | small     |            4 |       44 / 64 |               0.9091 / 0.9091 |       0.1667 |             0.9000 |        3.00x |
| Beacon        | medium    |            4 |       60 / 83 |               0.8824 / 0.9375 |       0.2222 |             0.9615 |        4.00x |
| Relay         | large     |            4 |      79 / 114 |               0.9545 / 0.9130 |       0.1200 |             0.9688 |        6.00x |
| **Aggregate** | —         |        **3** | **183 / 261** |           **0.9200 / 0.9200** |   **0.1636** |         **0.9487** |    **4.59x** |

The replay also publishes the exact confusion counts, unknown records, stable,
changed, and ambiguous identities, cold and warm durations, changed and reused
recomposition units, seven privacy findings, and the missingness of external
reviewer usefulness. Metrics are recomputed by the validator rather than trusted
as opaque fixture fields.

## Decision boundary

The W-006 decision is **narrow**. CARTOGRAPH may retain this local aggregate
replay as a development and review gate for explicitly declared portfolios. The
report does not graduate general federation, population-level accuracy,
performance guarantees, certification, adoption, or reviewer usefulness claims.

Before widening the scope, the project needs a consented reviewer study with no
hidden telemetry, additional pinned public or sanitized portfolios at declared
size tiers, and the same negative missing-repository, version-skew, and privacy
cases. The report is governance evidence; it does not change GraphSnapshot,
GraphDiff, workspace identity, boundary, recomposition, or privacy versions.

## Privacy and reproducibility

The protocol requires `network: false`, `sourceBodiesIncluded: false`,
`credentialsUsed: false`, `hiddenTelemetry: false`, and `userDataIncluded: false`.
It retains repository or sanitized references, immutable revision tokens,
aggregate graph cardinalities, digests, and explicit limitations only. The
fixture is replayable offline and is not a live benchmark or a representative
population sample.
