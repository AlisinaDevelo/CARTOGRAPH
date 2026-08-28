# SCIP import and export

E-017 adds a bounded, local-first interchange contract for the [SCIP
protocol](https://github.com/scip-code/scip/blob/main/scip.proto). The contract
uses the SCIP index concepts of metadata, documents, occurrences, symbols,
external symbols, and symbol relationships, then adds explicit CARTOGRAPH
extensions for stable keys and evidence references.

Run the checked-in round-trip fixture with:

```sh
npm run scip:validate
```

The reviewed fixture is
[`round-trip.v0.1.json`](../test/fixtures/scip-interchange/round-trip.v0.1.json)
and the JSON Schema is
[`scip-interchange.v0.1.schema.json`](../schema/scip-interchange.v0.1.schema.json).

## Contract boundary

`cartograph.scip-interchange` is a v1 JSON projection. It is an import/export
boundary, not a compiler or source indexer. CARTOGRAPH accepts already-produced
SCIP-shaped records and maps them to the canonical GraphSnapshot contract; it
does not run a SCIP indexer, execute repository code, resolve a package, fetch
missing symbols, or contact a network. The fixture and runtime reject absolute
local roots, file URIs, source-body `text` payloads, and unknown fields.

Metadata records the SCIP protocol version and tool identity. CARTOGRAPH
provenance additionally records the graph and capability versions and always
sets `sourceBodiesIncluded` to `false`. A default `redacted://project-root`
prevents local checkout paths from entering exported artifacts.

## Mapping rules

| SCIP record                               | GraphSnapshot mapping                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Document                                  | `module` node keyed by `cartographStableKey`, or `scip:document:<relativePath>`  |
| Function, method, class, and type symbols | Canonical function/module nodes with stable keys; unknown kinds remain `unknown` |
| External symbol                           | `external_service` node with its declared stable key                             |
| Definition occurrence                     | `contains` edge from the document to the symbol                                  |
| Import occurrence                         | `depends_on` edge from the document to the symbol                                |
| Read/write occurrence                     | `reads`/`writes` edge from the document to the symbol                            |
| Implementation relationship               | `implements` edge                                                                |
| Type-definition relationship              | `contains` edge                                                                  |
| Reference relationship                    | `depends_on` edge                                                                |

Each emitted edge carries a deterministic `user` evidence record whose
reference is `scip://...` or a portable `cartographEvidenceRefs` extension.
Those extension references are retained during import, export, and re-import;
they are not treated as source bodies.

## Unsupported fields

SCIP fields without a GraphSnapshot equivalent are never silently discarded.
The import/export report lists a stable `SCIP_*` code, field path, reason, and
the preservation strategy. The v1 fixture demonstrates report-only symbol
documentation and enclosing occurrence ranges. Relationship targets that are
not declared, non-portable evidence, unknown node kinds, non-certain edge
confidence, unresolved reasons, diagnostics, and unsupported edge kinds are
also reported. A report can be consumed only after its unsupported list has
been reviewed by the caller.

The contract preserves identity and evidence references, not source text or
compiler internals. CARTOGRAPH's compiler-backed TypeScript analyzer owns
source-backed analysis; the SCIP boundary is the broader graph, report, policy,
and reconciliation product's portable interchange layer.

## Determinism and compatibility

Indexes, mappings, unsupported records, and snapshots are canonicalized before
serialization. Repeated serialization is byte-stable, duplicate document and
symbol declarations fail closed, and the maximum document, symbol,
occurrence, and relationship counts are bounded. Version `1` is registered in
[`schema/compatibility.json`](../schema/compatibility.json) and checked by
`npm run schema:compatibility`.
