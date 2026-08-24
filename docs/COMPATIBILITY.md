# Compatibility and versioning

CARTOGRAPH treats snapshots and diffs as machine-readable contracts. Their
version is independent from the npm package version so a package patch release
cannot silently change an artifact's meaning.

The current contract inventory is in
[`schema/compatibility.json`](../schema/compatibility.json), and the canonical
GraphSnapshot shape is in
[`schema/graph-snapshot.v0.1.schema.json`](../schema/graph-snapshot.v0.1.schema.json).
The canonical GraphDiff shape is published in
[`schema/graph-diff.v0.1.schema.json`](../schema/graph-diff.v0.1.schema.json);
its summary counts are derived from the canonical change arrays and checked by
the runtime validator.
The extractor capability and unknown-semantics registry is versioned separately
in [`schema/capability-registry.v0.1.json`](../schema/capability-registry.v0.1.json)
and its JSON Schema.
Unsupported-construct definitions are versioned in
[`schema/diagnostic-registry.v0.1.json`](../schema/diagnostic-registry.v0.1.json)
and its JSON Schema; every analyzer diagnostic resolves to a registered code,
severity, source-span evidence contract, and actionable remediation.
Digest-bound policy bundles use the independent `policyBundles` contract in the
same manifest and are defined by
[`schema/policy-bundle.v0.1.schema.json`](../schema/policy-bundle.v0.1.schema.json).
Their digest-only migration reports use the reviewed `policyBundleMigrations`
contract and [`schema/policy-bundle-migration.v0.1.schema.json`](../schema/policy-bundle-migration.v0.1.schema.json).
Assurance signing records use the reviewed `assuranceSigning` contract and
[`schema/assurance-signing.v0.1.schema.json`](../schema/assurance-signing.v0.1.schema.json).
Remediation suggestion records and reports use the reviewed
`remediationSuggestions` contract and
[`schema/remediation-suggestion.v0.1.schema.json`](../schema/remediation-suggestion.v0.1.schema.json).
The deterministic rule catalog uses the reviewed `remediationRules` contract
and [`schema/remediation-rules.v0.1.schema.json`](../schema/remediation-rules.v0.1.schema.json).
Human remediation review records use the reviewed `remediationReviews`
contract and [`schema/remediation-review.v0.1.schema.json`](../schema/remediation-review.v0.1.schema.json).
Offline remediation evaluation reports use the reviewed `remediationEvaluations`
contract and [`schema/remediation-evaluation.v0.1.schema.json`](../schema/remediation-evaluation.v0.1.schema.json).

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

## D-003 initial diff publication

D-003 publishes the existing GraphDiff v0.1 contract as a standalone JSON
Schema and makes its machine-readable summary explicit. Writers emit stable
counts for added, removed, and changed nodes, edges, and diagnostics; the
runtime rejects a summary that disagrees with the change arrays. The golden
valid and malformed fixtures exercise both the JSON Schema and runtime
validator, while repeated canonical serialization is required to be byte
identical. This is the first published diff artifact contract; no prior
standalone GraphDiff JSON Schema was shipped.

## Change control

`npm run schema:compatibility` verifies the manifest, runtime constants, and
published JSON Schema. It also rejects an unreviewed current-version entry.
`npm run check` runs this command, so the required CI checks fail closed when a
schema version changes without the manifest and review/migration record being
updated. Hosted checks are a separate environment; the same command is the
local replacement when they are unavailable.

## X-008 additive review

X-008 adds the `AMBIGUOUS_PACKAGE_CONDITION` diagnostic and documents package
`exports`/`imports` condition evidence in the capability and diagnostic
registries. This is an additive registry entry: version `1` remains current,
existing readers can ignore the new diagnostic code, and no snapshot shape or
migration is required. The merged implementation and its Node16/NodeNext
fixtures were re-run through the full local compatibility and test gates.
