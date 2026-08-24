# Snapshot and identity migration matrix

The machine-readable transition matrix is
[`schema/migrations/migration-matrix.v0.1.json`](../schema/migrations/migration-matrix.v0.1.json).
The current published snapshot and diff readers accept version `1`. Writers
emit version `1`; an older artifact must be migrated explicitly and an unknown
version is rejected.

| Source                     | Target           | Automatic path                                        | Manual review | Identity/evidence result                                                                                                                              |
| -------------------------- | ---------------- | ----------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GraphSnapshot v0           | GraphSnapshot v1 | `cartograph migrate-snapshot`; `migrateGraphSnapshot` | Required      | `#` function delimiters become `:`; edge endpoints follow the node map; fixture evidence is preserved; capability registry version `1` is synthesized |
| GraphSnapshot v1           | GraphSnapshot v1 | No migration; canonicalization only                   | Normal review | No identity rewrite; duplicate/conflicting records fail closed                                                                                        |
| Unknown or retired version | —                | None                                                  | Blocked       | The reader raises an actionable migration error; no silent reinterpretation                                                                           |

The v0-to-v1 migration emits a deterministic `SnapshotMigrationReport`. It
contains every node and edge identity mapping, the changed mappings, fields
synthesized by the migration, and explicit evidence-loss notes. A migration is
not complete until the report is reviewed against the source and the historical
fixture remains reproducible.
