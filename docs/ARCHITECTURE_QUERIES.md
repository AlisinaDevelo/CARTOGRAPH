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

The current v0.1 executor supports two operations:

- `select-nodes` applies one or more bounded node predicates;
- `select-edges` applies one or more bounded edge predicates and returns the
  selected endpoints when node projection is enabled.

Predicates within one selector list are ORed; fields within one predicate are
ANDed. Node selectors can match exact IDs, stable keys, kinds, names,
languages, or repository-relative location prefixes. Edge selectors can match
endpoints, declared edge kinds, confidence, and whether evidence is present.
An empty selector and an unknown field are invalid.

`reachability`, `dependency-path`, `boundary-crossing`, `cycles`,
`source-body-search`, `remote-query`, and `mutation` are named in the contract
as unsupported operations. They return a deterministic warning result rather
than being guessed or silently executed. Q-002 is the separate roadmap item
for bounded traversal and path operations.

## Bounds and output

Every request carries limits for depth, nodes, edges, and serialized result
bytes. The v0.1 selector executor does not traverse, but it still validates and
echoes the traversal ceiling so later operations cannot bypass the contract.
When a result would exceed a ceiling, the executor returns no partial result
and emits `QUERY_RESOURCE_LIMIT` with the affected limit.

Results use canonical ordering: nodes by `stableKey,id`, edges by
`from,to,kind`, diagnostics by `id`, and evidence by `id`. Evidence projection
is explicit: `full` preserves the safe evidence fields, `summary` keeps the
review location and detector/hash identity, and `none` keeps only the evidence
ID and kind. The projection never permits source bodies or absolute paths.

Snapshot diagnostics selected by returned nodes or edges are projected with
their code, severity, remediation, and evidence IDs. Contract diagnostics are
stable and actionable: malformed requests fail validation, unsupported
operations return `QUERY_OPERATION_UNSUPPORTED`, and resource breaches return
`QUERY_RESOURCE_LIMIT`.

The query API is exported from the core package for local callers. A dedicated
CLI query command and traversal/path execution remain follow-on work under
Q-002; the v0.1 contract does not imply a hosted query service.
