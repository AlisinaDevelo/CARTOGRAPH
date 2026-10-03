# Local architecture history

`cartograph history` keeps a local, content-addressed store of the records
needed for longitudinal analysis: snapshots, diffs, policies, decisions,
finding lifecycles, workspace compositions, and the analyzer provenance that
produced them. It is a directory: no service, database, network access, or
telemetry is involved. The default location is `.cartograph/history`.

```sh
cartograph history import -r snapshot=graph.json -r diff=diff.json -r policy=.cartograph/policy.json
cartograph history list --revision <sha>
cartograph history verify
cartograph history export --revision <sha> -o exported/
cartograph history repair
```

## Records and references

Each input is validated against its CARTOGRAPH contract and stored as a
`cartograph.history-record` ([schema](../schema/history-record.v0.1.schema.json)):
the record kind, the body's contract schema version, the revision it
describes, explicit references, and the canonical body. The record's ID is the
SHA-256 of its canonical bytes, and it is written once to
`objects/<first two hex>/<id>.json` and never modified. Importing the same
content again is a no-op. Records carry no timestamps, so identical inputs
always produce the same IDs.

A snapshot record carries its commit as `revision`. A diff record carries its
head commit and references both revisions it connects (`revision:<sha>`).
`verify` reports references to revisions whose snapshot was never imported,
but they don't fail verification, because a store may hold only diffs.

Every import also stores a `provenance` record: the tool version and the
analyzer fingerprint of the build that ran the import.

## Index

`index.json` ([schema](../schema/history-index.v0.1.schema.json)) lists every
record's ID, kind, schema version, revision, and references. It is derived
from the objects and can always be rebuilt.

## Integrity, recovery, and concurrency

- Objects and the index are written to a temporary file and renamed into
  place, so a crash never leaves a partial record.
- An exclusive `lock` file serializes imports and repairs. A lock left by an
  interrupted run is reported. `repair` clears it.
- `verify` checks that each object's name matches the digest of its bytes,
  that the bytes are the canonical form of a valid record whose body still
  satisfies its contract, and that the index matches the objects. It exits 2
  on corrupt, missing, or unindexed records, an inconsistent index, or
  leftover files.
- `repair` moves corrupt objects to `quarantine/` (it deletes nothing valid),
  removes leftover temporary files and a stale lock, and rebuilds the index
  from the valid objects.

## Migration

Legacy (v0) snapshots are migrated to the current snapshot contract when
imported, so the store only holds current-version bodies, and each record
records its body's schema version. The store format itself is version 1. A
future store version will ship a `history migrate` step that rewrites records
into new objects and rebuilds the index, leaving the old objects for rollback
until they are removed explicitly.

## Export

`export` writes the selected records' bodies as standalone contract
documents (for example `snapshot-<id prefix>.json`) to a new directory. Those
documents can be passed to any CARTOGRAPH command or packaged with
`cartograph bundle create`.

## Trends

```bash
cartograph history trends --revision <older-sha> --revision <newer-sha> \
  [--policy-record <id>] [--decisions-record <id>]
```

`trends` recomputes architecture metrics (`cartograph.trend-metrics`
v1, [schema](../schema/trend-metrics.v0.1.schema.json)) from the stored
snapshots of the given revisions, in the order given. Every metric is a ratio
with an explicit numerator, denominator, and scope, so a value can always be
checked by hand. A metric with nothing to measure, or no stored evidence, is
`unavailable` with a reason instead of zero.

Per revision:

| Metric                                                             | Numerator / denominator                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `boundary-crossing-imports`                                        | local imports between boundaries / local imports                          |
| `bidirectional-boundary-pairs`                                     | boundary pairs importing each other / boundary pairs connected by imports |
| `modules-in-import-cycles`                                         | modules on an import cycle / local modules                                |
| `import-cycle-groups`                                              | import cycles / local modules                                             |
| `unresolved-edges`                                                 | edges without resolved evidence / edges                                   |
| `diagnostics-per-node`                                             | diagnostics / nodes                                                       |
| `policy-violation-rate`                                            | violations / evaluated rules (needs `--policy-record`)                    |
| `decision-coverage`                                                | modules named by a decision / local modules (needs `--decisions-record`)  |
| `ownership-coverage`, `active-waivers`, `runtime-reconciled-edges` | unavailable until the store records that evidence                         |

A module's boundary is `packages/<name>`, `<src|lib|app|source>/<directory>`,
or its top-level directory.

Between neighbouring revisions, `node-churn` and `edge-churn` count added,
removed, and changed nodes and edges over the larger revision, and
`renamed-nodes` counts identities the diff carried across a rename. A rename
therefore leaves the structural metrics unchanged and does not count as node
churn.

The policy and decisions records, when given, apply to every revision, so the
trend reflects code changes rather than rule changes. Each measured revision
names the record it was computed from and the snapshot, record, and capability
registry versions. A revision with no stored snapshot is `missing`, and the
intervals next to it are unavailable rather than bridged. Legacy snapshots
are migrated on import, so they produce the same metrics as current ones.
Changing any metric's definition, scope, or denominator bumps
`metricsVersion`.
