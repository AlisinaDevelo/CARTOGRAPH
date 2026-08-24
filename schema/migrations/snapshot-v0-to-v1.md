# GraphSnapshot v0 to v1 migration

## Transition

- Source: legacy `GraphSnapshot` v0.
- Target: `GraphSnapshot` v1 with capability registry version `1`.
- Mode: deterministic automatic rewrite followed by mandatory human review.
- Library path: `migrateGraphSnapshot` in `src/core/migrations.ts`.
- CLI path: `cartograph migrate-snapshot <input> --report <report.json>`.
- Historical fixture: `test/fixtures/snapshots/legacy-v0.graph.json`.

## Identity rewrite

Legacy function IDs used `#` between the module path and function name. The
migration replaces that delimiter with `:` and uses the resulting canonical ID
as both `id` and `stableKey`. Edge endpoints are rewritten through the complete
node map, so every changed edge identity is reported rather than inferred from
the final graph.

The migration report contains all node and edge identity mappings, filtered
changed mappings, synthesized fields, and evidence-loss notes. The fixture has
no source-evidence loss. It does require review because v0 did not declare the
capability registry version; v1 synthesizes registry version `1` explicitly.

## Review gate

Reviewers must compare the report's `changedNodeIdentities` and
`changedEdgeIdentities` with the source migration and confirm that no evidence
loss note is unexplained. Unknown schema versions, dangling edge endpoints,
invalid evidence, and malformed legacy records fail closed.
