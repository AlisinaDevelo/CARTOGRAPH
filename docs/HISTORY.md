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
- `import` re-reads an object that already exists and stops if its bytes
  differ, refuses a store whose root or `objects/` is a symbolic link, and
  reports two different snapshots of one revision under `conflicts` (both
  are kept).
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

### Breaks, uncertainty, and restatements

Trends never interpolate across gaps or rank values that are not comparable.
Each revision lists `marks`, and each interval lists the `breaks` between its
two revisions, with machine-readable reasons:

| Reason                   | When                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| `missing-revision`       | no stored snapshot for the revision                                 |
| `removed-by-retention`   | the snapshot was removed by `history gc` (a tombstone names it)     |
| `partial-snapshot`       | the snapshot has error or `PARTIAL_*` diagnostics                   |
| `contract-change`        | snapshot or capability registry versions differ                     |
| `adapter-change`         | an extractor present in both revisions changed version              |
| `policy-change`          | a different policy record applies (`--policy-at revision=id`)       |
| `decisions-change`       | a different decisions record applies (`--decisions-at revision=id`) |
| `workspace-scope-change` | the set of workspace package nodes differs                          |
| `migration`              | the snapshot was migrated from an older contract on import          |
| `sampling-change`        | the evidence kinds differ (for example runtime evidence appears)    |

Each interval's `changes` lists every per-revision metric as `comparable`
(with `from`, `to`, and `delta`), `incomparable` (with `from`, `to`, and the
reasons, but no delta), or `unavailable`. A policy or decisions change only
affects its own metric; every other break affects all of them. Churn is not
computed across a contract change.

`boundary-crossing-imports` carries an `uncertainty` band when local modules
have unresolved imports: the value it would take if every unknown import
crossed a boundary (`upper`) or none did (`lower`).

`--explanations notes.json` (`cartograph.trend-explanations` v1,
[schema](../schema/trend-explanations.v0.1.schema.json)) attaches a
reviewer's note to the break it explains, matched by `from`, `to`, and
`reason`. `unexplainedBreaks` counts the rest.

`--previous report.json` compares this run with an earlier report for the
same revisions. Every value that changed is listed under `restatements`, with
the reasons that apply: `evidence-changed` (a different stored snapshot),
`metrics-version-change`, `policy-change`, or `decisions-change`.

## Retention and compaction

```bash
cartograph history gc --policy retention.json --as-of 2026-10-01T00:00:00Z          # plan only
cartograph history gc --policy retention.json --as-of 2026-10-01T00:00:00Z --apply  # delete
```

A retention policy (`cartograph.history-retention` v1,
[schema](../schema/history-retention.v0.1.schema.json)) has:

- `rules`: per record kind, and optionally per classification, a
  `maxAgeDays` and/or `keepLast`. A record is removed only if a rule that
  applies to it says so and no applicable rule keeps it. A record older than
  `maxAgeDays` days at `--as-of` (strictly older; exactly at the boundary is
  kept) or outside the newest `keepLast` is a candidate.
- `classifications`: `public`, `internal` (the default), or `restricted`,
  assigned by record ID or revision, so rules can treat restricted evidence
  differently.
- `holds`: legal or owner holds by record ID or revision, with an owner,
  reason, and optional `until` (inclusive). A held record is never removed.
- `compactDerivedDiffs`: drop stored diffs that the retained snapshots
  regenerate byte for byte. A diff that cannot be regenerated, or whose
  snapshots would not be retained, stays (`not-reproducible`).

Age comes from evidence, not from import time: a snapshot's
`revision.authoredAt`, and a diff's `toRevision.authoredAt`. Undated records,
including migrated legacy snapshots without `authoredAt`, and kinds without a
date are never removed by age (`undated`).

Removal never breaks retained evidence. A snapshot whose revision, or a
record whose ID, is referenced by a record that stays is kept
(`referenced`). This is repeated until nothing changes, so removing a diff
can release the snapshots only it referenced.

`gc` refuses a store that does not verify. Run `repair` first. Without
`--apply` it only reports the plan: every record kept with its reasons, and
every removal with its rule. With `--apply`, for each removal it:

1. writes `tombstones/<id>.json` (ID, kind, revision, rule, and `--as-of`),
2. rewrites the index without it,
3. deletes the object and checks that the file is gone.

If this is interrupted, `repair` deletes objects that already have a
tombstone instead of re-indexing them. Re-importing the same content later
removes its tombstone and restores the record.

**Removal is irreversible.** The tombstone keeps only metadata. The evidence
itself cannot be recovered from the store. Export what you need first.
Retained metrics are recomputed from what stays, so `trends` over retained
revisions gives the same result before and after `gc`.

## Selective and redacted export

`export` selects by `--revision`, `--id`, and `--kind` (each repeatable
except `--revision`). `--profile team|public` applies the
[bundle sharing](SHARING.md) redaction to every exported record, then checks
that each record still satisfies its contract unchanged by
canonicalization. If redaction would break or merge evidence (for example
two IDs that redact to the same value), the export fails, and the error names
the record, not the value.
