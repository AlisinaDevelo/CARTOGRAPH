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
with an `evidence` field change, while a new unresolved diagnostic is reported
under `diagnostics.added` with its source evidence. Canonicalization sorts
records and evidence before comparison, so equivalent input ordering produces
the same serialized diff. Golden mutation fixtures under
`test/fixtures/snapshots/graph-diff/` exercise every classification.

## Identity

The initial stable key combines the node kind with normalized module and symbol identity. This is deterministic but is not yet refactor-stable. The Year 2 identity work adds Git rename evidence, AST fingerprints, signatures, and neighborhood similarity while surfacing ambiguous matches rather than guessing.

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

- architecture policy and ADR evaluation;
- a reusable GitHub Action and Check annotations;
- refactor-stable identity;
- additional framework or language adapters;
- OpenTelemetry reconciliation;
- hosted collaboration or organizational history.
