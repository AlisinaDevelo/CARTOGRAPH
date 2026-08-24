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

- `src/core`: versioned graph and diff contracts, validation, canonicalization, and comparison.
- `src/analyzers/typescript`: TypeScript program loading and language-level relationships.
- `src/analyzers/express`: bounded Express route semantics.
- `src/git`: read-only Git validation and revision materialization in narrow temporary directories.
- `src/report`: deterministic JSON, Markdown, and standalone HTML rendering.
- `src/cli.ts`: argument parsing, exit behavior, and orchestration only.

Adapters depend on the core contract. The core does not depend on a framework adapter.

## Canonical graph

A snapshot contains versioned metadata, typed nodes, typed edges, evidence, and diagnostics. The checked-in [GraphSnapshot v0.1 JSON Schema](../schema/graph-snapshot.v0.1.schema.json) defines the portable interchange shape. Portable artifacts use repository-relative POSIX paths. They do not contain absolute paths or source bodies.

Every edge must contain at least one evidence record or an explicit unresolved reason. Source-evidence records contain a normalized path, source span, detector identity, and content hash. Confidence is recorded on the edge; it distinguishes direct semantic evidence from bounded inference and is not a probability.

Canonicalization validates records, rejects conflicting identities, removes exact duplicates, and sorts every collection. The runtime validator also enforces cross-record node references that JSON Schema cannot express portably. Identical input must serialize identically.

## Identity

The initial stable key combines the node kind with normalized module and symbol identity. This is deterministic but is not yet refactor-stable. The Year 2 identity work adds Git rename evidence, AST fingerprints, signatures, and neighborhood similarity while surfacing ambiguous matches rather than guessing.

## Git revisions

Revision analysis validates refs with Git, archives each tree into its own temporary directory, analyzes the extracted source, and removes the directory in a `finally` path. It does not checkout, reset, stash, or otherwise alter the caller's worktree.

The CLI records the exact base and head commit. Future pull-request support will also record the merge base instead of hiding Git's three-dot semantics.

## TypeScript boundary

The first adapter pins the TypeScript 6-era compiler surface through ts-morph. TypeScript 7.0 moved the compiler to Go and does not expose the TypeScript 6 compiler API. The adapter boundary and fixture matrix exist so the core can survive the TypeScript 7.1 API transition without a graph-schema rewrite.

## Reports

JSON is the canonical machine contract. Markdown is optimized for review summaries. HTML is a self-contained local artifact with no remote scripts, styles, fonts, or requests. Report rendering escapes all repository-controlled text.

## Deferred components

The following are roadmap items, not current implementation claims:

- architecture policy and ADR evaluation;
- a reusable GitHub Action and Check annotations;
- refactor-stable identity;
- additional framework or language adapters;
- OpenTelemetry reconciliation;
- hosted collaboration or organizational history.
