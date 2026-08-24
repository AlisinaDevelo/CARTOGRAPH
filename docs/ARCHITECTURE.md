# Architecture

CARTOGRAPH is a local TypeScript application with explicit internal boundaries. The current design avoids a server, database, graph database, language model, and repository-code execution.

## Data flow

```text
repository or materialized Git revision
                  |
                  v
       TypeScript project loader
                  |
                  v
 semantic analyzer + narrow resolvers
                  |
                  v
 canonical GraphSnapshot + diagnostics
                  |
          +-------+-------+
          |               |
          v               v
    graph validator    diff engine
                          |
                          v
               JSON / Markdown / HTML
```

## Module boundaries

- `src/core`: versioned graph, diff, and configuration contracts, validation, canonicalization, and comparison.
- `src/analyzers/typescript`: TypeScript program loading and language-level relationships.
- `src/analyzers/express`: bounded Express route semantics.
- `src/git`: read-only Git validation and revision materialization in narrow temporary directories.
- `src/report`: deterministic JSON, Markdown, and standalone HTML rendering.
- `src/cli.ts`: argument parsing, config warning reporting, exit behavior, and orchestration only.

Configuration is loaded before analysis. Its schema and runtime parser apply
deterministic defaults, reject unknown keys unless explicit warn mode is
selected, and validate every path as repository-relative. The analyzer receives
the resolved include/exclude selectors and resource ceilings; it fails closed
before emitting a partial snapshot when a ceiling is exceeded.

Local policy configuration is a separate, data-only v0.1 contract. Its bounded
node, edge, and diff selectors are parsed by `src/core/policy.ts`; the local
reader accepts only an in-repository regular JSON file and defaults to
informational mode. It does not evaluate rules, fetch remote policy, execute
commands, or grant authority. Evaluation and enforcing exit behavior remain
separate roadmap boundaries.

The TypeScript loader reads JSON/JSONC configuration through the compiler parser
without executing configuration or repository code. It validates and follows
in-repository `extends` chains and recursively follows solution-style project
references, applies each referenced project’s include and exclude selectors,
and uses the owning project’s compiler options for path aliases. Cycles, missing
bases, out-of-root references, and unsupported reference shapes fail with
deterministic `TypeScriptConfigError` codes and paths. Source and
dependency/build paths are selected in canonical order; symlinked or out-of-root
files are never loaded.

For Node16 and NodeNext projects, module resolution also follows in-repository
package `exports` and `imports` maps. The resolver passes TypeScript’s implied
per-file ESM or CommonJS mode into the compiler, so `import`, `require`, `node`,
and `types` branches produce edges to the compiler-selected target. Conditional
maps that expose additional environment branches remain visible as an
`AMBIGUOUS_PACKAGE_CONDITION` warning with the selected and available condition
sets in the diagnostic message.

Adapters depend on the core contract. The core does not depend on a framework adapter.

## Canonical graph

A snapshot contains versioned metadata, the capability-registry version, typed nodes, typed edges, evidence, and diagnostics. The checked-in [GraphSnapshot v0.1 JSON Schema](../schema/graph-snapshot.v0.1.schema.json) defines the portable interchange shape. Portable artifacts use repository-relative POSIX paths. They do not contain absolute paths or source bodies.

Every edge must contain at least one evidence record or an explicit unresolved reason. Source-evidence records contain a normalized repository-relative path, a positive source span, a versioned detector identity, and a content hash. Unknown evidence fields—including source bodies and snippets—are rejected. Confidence is recorded on the edge; it distinguishes direct semantic evidence from bounded inference and is not a probability. Canonical serialization normalizes identifier separators to `/` and date-time metadata to UTC ISO 8601; malformed records fail with structured contract paths.

Canonicalization validates records, rejects conflicting identities, removes exact duplicates, and sorts every collection. The runtime validator also enforces cross-record node references that JSON Schema cannot express portably. Identical input must serialize identically.

## Diff semantics

The diff engine compares canonical snapshots by semantic identity rather than
array position:

- nodes use `stableKey`;
- edges use the `from`/`to`/`kind` tuple; confidence, evidence, and an
  `unresolvedReason` are fields on that relationship;
- diagnostics use their stable `id` and retain severity, remediation, edge or
  node context, and evidence.

Each identity is reported as added, removed, or changed. Changed records retain
the complete before/after values plus a deterministic list of changed field
paths. An evidence-only relationship update therefore remains a changed edge
with an `evidence-only` classification; a confidence-only update is marked
`confidence-changed`. Removed and added edges are also paired into a derived
`edges.rewired` view when a deterministic shared-evidence, source, or target
match proves an endpoint rewire. The original added/removed arrays remain
unchanged for v0.1 consumers. Node and diagnostic changes carry explicit
`node-changed` and `diagnostic-changed` classifications. Canonicalization sorts
records and evidence before comparison, so equivalent input ordering produces
the same serialized diff; ambiguous rewire candidates are left as ordinary
added/removed edges. Golden mutation fixtures under
`test/fixtures/snapshots/graph-diff/` exercise every classification.

The D-010 diff pipeline runs the P-001 identity reconciliation before deriving
node sets. Unique refactor matches are emitted under `identity.matches` with
the selected method, confidence, score, and contributing signals; their nodes
are removed from false added/removed pairs. Optional Git path-history pairs can
add a bounded `path-history` signal, and `maxCandidates` fails closed when the
similarity search would exceed its local budget. Equal-score and non-mutual
candidates remain in the conservative added/removed sets and also appear under
`identity.ambiguous`, with `AMBIGUOUS_IDENTITY_MATCH` for equal-score ties and
`IDENTITY_COLLISION` for non-mutual destination contention, so distinct nodes
are not silently collapsed.

## Impact traversal

`computeImpactSubgraph` provides a local, bounded reachability view for a set
of node IDs or stable keys. Forward mode follows `from` to `to`; reverse mode
follows the same edge records backwards while preserving their original
confidence and evidence. Results include deterministic node depths, traversed
edges, explicit unresolved edges, closed cycle paths, and edges withheld at a
configured depth limit. Unresolved edges are traversed by default so potential
impact is not hidden, with `includeUnresolved: false` available when a review
needs only resolved relationships. Node and edge ceilings fail closed with an
actionable resource diagnostic rather than truncating the result.

## Identity

The initial stable key combines the node kind with normalized module and symbol
identity. `reconcileGraphNodeIdentities` is the separate, deterministic P-001
identity primitive used to compare two canonical snapshots:

1. An exact stable-key match is `stable-key`/`exact`; changing only a source
   line therefore preserves identity.
2. An unmatched node may match a unique reciprocal candidate with the same kind,
   language, and name after a file move (`same-name`/`strong`).
3. A supported rename may match a unique reciprocal candidate with the same kind
   and an identical directed neighborhood profile (edge kind plus neighboring
   stable keys), even when the name changes (`neighborhood`/`strong`).
4. An optional Git path-history pair can provide a bounded `path-history` signal
   for a file move or rename (`path-history`/`strong`).

Candidates are canonicalized and sorted before matching. Equal-score or
non-mutual candidates are returned as explicit ambiguity records; they are
never selected as a best effort. Non-mutual candidates emit
`IDENTITY_COLLISION`; equal-score candidates emit `AMBIGUOUS_IDENTITY_MATCH`.
Fallback matches emit `IDENTITY_FALLBACK_MATCH` with one evidence record per
signal. Weak same-path or neighborhood-overlap rename candidates are exposed
under `identity.unsupported` with `UNSUPPORTED_IDENTITY_RENAME` rather than
being guessed. Ambiguous and unsupported nodes remain in the conservative
added/removed sets alongside their diagnostics, so a genuinely distinct object
is not hidden. Every candidate or signal is retained as deterministic evidence
for reviewer action. The matcher does not rewrite stable keys or mutate
snapshots. The diff pipeline consumes this contract without rewriting
canonical stable keys.

## Git revisions

Revision analysis validates refs with Git, archives each tree into its own temporary directory, analyzes the extracted source, and removes the directory in a `finally` path. It does not checkout, reset, stash, or otherwise alter the caller's worktree.

Revision refs are resolved locally; the command never fetches or implicitly
contacts a remote. A dirty caller worktree is left untouched and is not mixed
into a commit-backed revision. Materialization fails closed at the 128 MiB
archive, 64 MiB extracted-tree, or 30 second subprocess ceilings and cleans
partial trees on every failure path. Snapshot files can also be compared
directly through `diff-snapshots` without Git.

The CLI records the exact base and head commit. Future pull-request support will also record the merge base instead of hiding Git's three-dot semantics.

## TypeScript boundary

The first adapter pins the TypeScript 6-era compiler surface through ts-morph. TypeScript 7.0 moved the compiler to Go and does not expose the TypeScript 6 compiler API. The adapter boundary and fixture matrix exist so the core can survive the TypeScript 7.1 API transition without a graph-schema rewrite.

## Reports

JSON is the canonical machine contract. Markdown is optimized for review summaries. HTML is a self-contained local artifact with no remote scripts, styles, fonts, or requests. Reports include the tool, GraphDiff schema, capability-registry, revision, evidence, and diagnostic context; rendering escapes all repository-controlled text. Report generation fails closed before truncation at 10,000 nodes, 20,000 edges, 5,000 diagnostics, or 16 MiB of UTF-8 output.

## Deferred components

The following are roadmap items, not current implementation claims:

- enforcing policy exit behavior, plus ADR lifecycle, report, and
  policy-binding evaluation;
- local ADR reference parsing and stale/missing reference diagnostics remain
  offline and data-only; lifecycle, report, and policy binding are separate
  contracts;
- a reusable GitHub Action and Check annotations;
- the remaining identity quality, portability, and history work;
- additional framework or language adapters and stronger runtime isolation
  enforcement beyond the v0.1 data-only adapter policy;
- automatic binding and CLI/report integration beyond the v0.1 local
  reconciliation and trace-safety contracts;
- hosted collaboration or organizational history.
