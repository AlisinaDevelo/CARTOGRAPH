# Patch-scoped graph and policy filtering

D-014 defines `cartograph.patch-filter`, a local report contract for reviewing
large GraphDiffs without presenting a partial graph as the whole result. The
filter is a projection around existing canonical snapshots, diffs, and policy
evaluations; it does not replace the analyzer or mutate any input.

## Request

A request contains:

- a stable `filterId` and contract/schema version;
- changed repository-relative files with `added`, `modified`, `removed`, or
  `renamed` status, including `previousPath` for renames;
- a `contextDepth` of `0` or `1` (the default is one hop);
- `includeGenerated`, defaulting to `false`;
- separate ceilings for selected nodes, edges, diagnostics, and omitted regions.

Paths are normalized POSIX repository paths. Absolute paths, URI-like values,
NUL/control values, and traversal are rejected. Changed paths may not be
repeated. The operation is read-only and has no network, process, or source
execution capability.

## Selection and omissions

The runtime canonicalizes both snapshots and the complete GraphDiff, then finds
changed roots from evidence paths on the appropriate revision side. A selected
record carries its side (`before` or `after`), identity, changed/context role,
depth, and evidence paths. Direct evidence is depth zero. With the default
depth-one mode, neighboring nodes and relationships are included in both graph
directions; depth zero selects only direct changed records. A changed edge or
diagnostic also keeps an unchanged endpoint visible as context without
reclassifying that endpoint as changed.

Generated changed files are excluded by default. Their file records and every
generated node, edge, or diagnostic are retained under `omitted`, with reason
`generated-file`. Non-generated records outside the selected context remain
visible as `outside-patch-context` omitted regions. Resource ceilings fail
closed rather than silently truncating a result. Canonical sorting and a
request digest make repeated runs byte-identical.

Rename identity is retained in `selection.diff.identity.matches`; added,
removed, changed, rewired, and diagnostic categories are projected by stable
identity. The report also records before/after totals and selected/omitted
counts so a reviewer can see the scope of the projection.

## Policy preservation

Policy must be evaluated against the complete GraphDiff before filtering. The
report stores the full evaluation digest and exact status (`passed`,
`violations`, or `unsupported`) and partitions every violation into
`retainedViolationIds` or `omittedViolationIds`. The union must equal the full
evaluation's violation set, so omitting a region cannot remove a violation or
turn it into a pass. If no full-diff evaluation is supplied, the report says
`source: "not-provided"` and `status: "not-provided"`; it never claims policy
success. Snapshot evaluations and evaluations for another diff are rejected.

## Validation

The checked-in fixture covers a rename, generated-file change, changed edge,
one-hop context, omitted graph region, and an unknown-edge policy violation.
The validator runs the report twice, validates both fixture and report JSON
Schemas, checks exact selections and digests, then repeats the scenario with
generated files explicitly included:

```sh
npm run patch-filter:validate
```

The library entry points are exported from `src/core/index.ts`:
`createPatchFilterReport`, `filterGraphDiff`, `parsePatchFilterReport`, and
`serializePatchFilterReport`.
