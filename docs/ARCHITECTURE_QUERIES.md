# Architecture query contract

CARTOGRAPH v0.1 defines a versioned, local query request and result contract
for asking bounded questions of one canonical `GraphSnapshot`. The machine
contracts are [`architecture-query.v0.1.schema.json`](../schema/architecture-query.v0.1.schema.json)
and [`architecture-query-result.v0.1.schema.json`](../schema/architecture-query-result.v0.1.schema.json);
the scenario corpus is
[`scenarios.v0.1.json`](../test/fixtures/architecture-query/scenarios.v0.1.json).
Validate the contract with:

```sh
npm run query-contract:validate
```

## Scope

The contract is deliberately local and data-only. A request consumes a
canonical snapshot already held by the caller. It does not fetch a repository,
read source bodies, execute repository code, write files, contact a network, or
send data to a provider. The executor does not mutate its snapshot input.

The v0.1 executor supports these operations:

- `select-nodes` applies one or more bounded node predicates;
- `select-edges` applies one or more bounded edge predicates and returns the
  selected endpoints when node projection is enabled;
- `neighbors` returns direct forward, reverse, or both-direction neighbors;
- `reachability` returns bounded downstream (`forward`) or upstream (`reverse`)
  impact, with `both` available for a combined view;
- `dependency-path` returns the deterministic shortest path between two exact
  node references, defaulting to `depends_on` edges;
- `boundary-crossing` returns edges with exactly one endpoint in the selected
  node boundary, classified as inbound or outbound;
- `cycles` reports closed paths discovered during bounded traversal.

Predicates within one selector list are ORed; fields within one predicate are
ANDed. Node selectors can match exact IDs, stable keys, kinds, names,
languages, or repository-relative location prefixes. Edge selectors can match
endpoints, declared edge kinds, confidence, and whether evidence is present.
Traversal operations use selected node predicates as roots. A dependency path
uses `path.from` and `path.to` references (an ID string or an `{id}` /
`{stableKey}` object) and may select a declared edge-kind list explicitly.
Selectors and path references cannot contain absolute paths, source bodies, or
remote references.

## Traversal semantics

`traversal.direction` accepts `forward`/`downstream`, `reverse`/`upstream`, or
`both`. Forward follows an edge's `from` to `to`; reverse follows the same
edge records backwards without rewriting their evidence. `edgeKinds` is an
explicit, bounded allow-list. Unresolved edges remain visible as unresolved
evidence and are traversed only when `includeUnresolved` is true.

Reachability and cycle results include canonical `nodeDepths` records. Cycle
records contain a closed node sequence and every traversed edge with its
projected evidence. Dependency-path records preserve path order in `paths`;
the top-level `nodes` and `edges` arrays remain canonically ordered for stable
serialization. Boundary records include the inside and outside node IDs, the
crossing direction, and the complete projected edge.

## Policy, decision, and ownership projections

Set `projection.metadata` to `full` (or `summary`) and pass a local metadata
document as the third argument to `executeArchitectureQuery`. The metadata
document can contain already-parsed local policy configurations and, when
available, their existing `cartograph.policy-evaluation` reports; an ADR
reference document plus validation diagnostics; explicit ownership hints; and
records for metadata that this contract cannot interpret. Projection is
read-only: it never evaluates a policy, loads a source, contacts a remote
catalog, or changes the supplied graph or evaluation.

The result keeps only policy rules whose node or edge selectors match returned
graph objects. Findings and exceptions retain their original IDs and evidence
references, with canonical `node:<id>` or `edge:<from>|<kind>|<to>` matches
added for the returned objects. Diff-target rules and any caller-supplied
unsupported records remain visible as unsupported metadata rather than being
treated as applicable snapshot rules. A missing policy evaluation is reported
as `METADATA_POLICY_EVALUATION_MISSING`; the query never recomputes it.

ADR references retain their file, lifecycle status, graph IDs, and validation
diagnostics. Stale references therefore remain visible when their diagnostic is
associated with the projection. Ownership is accepted only from explicit
targeted hints. Missing, stale, unsupported, or disagreeing hints produce
`METADATA_OWNERSHIP_MISSING`, `METADATA_OWNERSHIP_STALE`,
`METADATA_OWNERSHIP_UNSUPPORTED`, or `METADATA_OWNERSHIP_CONFLICT`; no owner is
inferred from a path, node name, contributor, or unmatched selector.

## Bounds and output

Every request carries limits for depth, nodes, edges, wall-clock time, and
serialized result bytes. The ceilings are `maxDepth <= 64`, `maxNodes <= 100,000`,
`maxEdges <= 200,000`, `maxTimeMs <= 120,000`, and `maxResultBytes <= 16 MiB`.
Defaults are depth 8, 10,000 nodes, 20,000 edges, 5,000 ms, and 4 MiB.

Results also accept an explicit `pagination` block. `pageSize` is a positive
cardinality limit up to 200,000 (the default preserves the unpaged result), and
the optional opaque `cursor` is supplied from the previous page's
`pagination.nextCursor`. Every result reports `pagination.total`,
`pagination.returned`, `pagination.hasMore`, the requested `pageSize`, and the
echoed cursor. Cursors are base64url tokens bound to the canonical snapshot,
normalized query, and page size; changing any of those inputs invalidates the
cursor. The executor sorts the complete match set before slicing, so repeated
queries over the same graph produce byte-identical pages. A page with more
matches sets `truncated: true` and emits a `nextCursor`; it never silently
discards the remaining matches. Malformed, stale, or mismatched cursors return
`status: "resource-limit"` with a `QUERY_CURSOR_INVALID` diagnostic instead of
restarting from the first page.

Depth boundaries do not silently discard evidence. They return `truncated: true`,
the canonical `truncatedEdges` list, and a `QUERY_TRUNCATED` diagnostic for
each withheld continuation edge. Node, edge, time, and output ceilings fail
closed with no partial result and a `QUERY_RESOURCE_LIMIT` diagnostic naming
the affected limit.

Results use canonical ordering: nodes by `stableKey,id`, edges by
`from,to,kind`, diagnostics by `id`, evidence by `id`, boundary records by
inside/outside/edge identity, and cycle records by their closed path identity.
Evidence projection is explicit: `full` preserves the safe evidence fields,
`summary` keeps the review location and detector/hash identity, and `none`
keeps only the evidence ID and kind. The projection never permits source
bodies or absolute paths.

Snapshot diagnostics selected by returned nodes or edges are projected with
their code, severity, remediation, and evidence IDs. Contract diagnostics are
stable and actionable: malformed requests fail validation, unsupported
operations return `QUERY_OPERATION_UNSUPPORTED`, missing path endpoints return
`QUERY_NODE_NOT_FOUND`, absent paths return `QUERY_PATH_NOT_FOUND`, and
resource breaches return `QUERY_RESOURCE_LIMIT`.

The query API is exported from the core package for local callers. A dedicated
CLI query command and hosted query service remain outside this contract.
Only `source-body-search`, `remote-query`, and `mutation` remain explicit
unsupported operations; they return a deterministic warning rather than being
guessed or silently executed.

For reusable text queries over snapshots and diffs, use the separate D-015
[`cartograph.graph-query-language`](../schema/graph-query-language.v0.1.schema.json)
contract. Its `v1 nodes`, `v1 edges`, and `v1 changes` grammar supports
evidence paths, confidence, exact revision selection, and bounded traversal;
`parseGraphQueryLanguage` produces a canonical AST and
`executeGraphQuery` fails closed at explicit resource ceilings. This language
is intentionally read-only and source-free and does not replace STRATA's
compiler-backed semantic analyzer.

## Inspectable explanations

Q-005 adds the versioned
[`cartograph.architecture-query-explanation`](../schema/architecture-query-explanation.v0.1.schema.json)
contract. `buildArchitectureQueryExplanation` joins one normalized query to
its already-computed result without executing another query or consulting a
repository. The portable object carries the canonical query plan, complete
result nodes and edges, ordered paths/cycles/boundary crossings, projected
evidence, policy/ADR/ownership metadata, explicit limits, tool and capability
versions, and uncertainty records for cycles, truncation, missing evidence,
diagnostics, unsupported metadata, and empty results.

The report projection is available as JSON, Markdown, or a self-contained HTML
document through `renderArchitectureQueryExplanation`. HTML uses a restrictive
content-security policy, a keyboard-focusable `<main>` landmark, a skip link,
semantic headings, and native `<details>` disclosures. All three formats are
deterministic across repeated runs. Reports remain local, read-only, network-
free, and source-body-free; evidence locations and IDs are retained, but source
contents are never copied. The five-case corpus and baseline evaluation cover
cycles, depth truncation, missing evidence, empty results, and metadata context:

```sh
npm run query:explanation:validate
```

## Quality and safety gate

Q-006 combines the query, impact, and explanation corpora into a public quality
and safety decision. The digest-bound
[`architecture-query-quality-gate`](../schema/architecture-query-quality-gate.v0.1.schema.json)
report checks deterministic correctness, precision and recall, explanation
completeness, fail-closed resource and malformed-input behavior, path-leakage
safety, repeatability, and reviewer-task completion. The current report narrows
impact claims because the synthetic impact precision is below its declared
floor, and defers multi-repository composition because workspace trust and
independent reviewer evidence are not measured. Run:

```sh
npm run query:quality:validate
```
