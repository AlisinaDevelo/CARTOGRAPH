# Compatibility and versioning

CARTOGRAPH treats snapshots and diffs as machine-readable contracts. Their
version is independent from the npm package version so a package patch release
cannot silently change an artifact's meaning.

The current contract inventory is in
[`schema/compatibility.json`](../schema/compatibility.json), and the canonical
GraphSnapshot shape is in
[`schema/graph-snapshot.v0.1.schema.json`](../schema/graph-snapshot.v0.1.schema.json).
The extractor capability and unknown-semantics registry is versioned separately
in [`schema/capability-registry.v0.1.json`](../schema/capability-registry.v0.1.json)
and its JSON Schema.
Digest-bound policy bundles use the independent `policyBundles` contract in the
same manifest and are defined by
[`schema/policy-bundle.v0.1.schema.json`](../schema/policy-bundle.v0.1.schema.json).

## Change categories

- **Additive:** an optional field, enum value, diagnostic, or report detail that
  old readers can ignore without changing existing meaning.
- **Breaking:** a required field, removed field, changed identity, changed
  meaning, or incompatible output shape. This requires a new major contract
  version and a compatibility review.
- **Deprecated:** a still-readable field or value retained for one documented
  compatibility window and excluded from new output.
- **Migration-required:** a deterministic rewrite or explicit reader migration
  is required before an artifact can be consumed safely.

The same categories apply to snapshots, diffs, reports, policies, adapters, and
policy bundles. A policy bundle's compatibility block must match the graph,
diff, capability, and bundle versions accepted by the importer.

## Reader and writer rules

Writers emit only the current version. Readers accept only versions listed in
the manifest's `supportedReaders` set. An unknown or retired version fails with
an actionable migration error; it is never silently treated as the current
version. A migration belongs in [`schema/migrations/`](../schema/migrations/)
and must include representative fixtures and a review decision.

The GraphSnapshot v0.1 runtime currently reads version `1`. GraphDiff v0.1
also uses version `1`. Snapshots and diffs expose capability registry version
`1`; a registry mismatch fails closed before a diff or report is produced. The
JSON Schema and runtime validator must change together; the compatibility check
rejects drift between them.

## Change control

`npm run schema:compatibility` verifies the manifest, runtime constants, and
published JSON Schema. It also rejects an unreviewed current-version entry.
`npm run check` runs this command, so the required CI checks fail closed when a
schema version changes without the manifest and review/migration record being
updated. Hosted checks are a separate environment; the same command is the
local replacement when they are unavailable.
