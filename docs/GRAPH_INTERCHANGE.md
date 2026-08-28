# Portable graph interchange

D-018 adds the versioned `cartograph.graph-interchange` boundary for consumers
that need canonical architecture evidence without adopting CARTOGRAPH's report
renderer. The boundary is local, deterministic, source-free, and offline. It
does not index a repository, resolve missing symbols, execute code, or contact a
network.

Run the checked-in round-trip fixture with:

```sh
npm run graph-interchange:validate
```

The fixture is
[`scenarios.v0.1.json`](../test/fixtures/graph-interchange/scenarios.v0.1.json),
and the contract schema is
[`graph-interchange.v0.1.schema.json`](../schema/graph-interchange.v0.1.schema.json).

## Formats

All three formats carry GraphSnapshot v1 revision and capability metadata,
canonical nodes, typed edges, diagnostics, and complete evidence records.

| Format    | Media type                                          | Shape                                                                                  | Reader                          |
| --------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| JSON      | `application/vnd.cartograph.graph-interchange+json` | A strict envelope containing the canonical `snapshot`                                  | `parseGraphInterchangeJson`     |
| JSON-LD   | `application/ld+json`                               | An inline-context document with `@id` nodes, deterministic edge IDs, and typed records | `parseGraphInterchangeJsonLd`   |
| Edge list | `application/vnd.cartograph.edge-list+json`         | UTF-8 NDJSON: one `meta` record followed by `node`, `edge`, and `diagnostic` records   | `parseGraphInterchangeEdgeList` |

The edge-list format is deliberately line-oriented so it can be streamed by a
small consumer while retaining the same canonical records. The serializer emits
LF line endings and one final newline; the reader also accepts CRLF input after
normalizing it to LF. Every artifact must begin with exactly one `meta` record
and contain no unknown record fields. It is not a lossy `from,to` shorthand:
node records, full edge records, evidence, confidence, unresolved reasons, and
diagnostics are all retained.

## Identity and provenance

Node `id` and `stableKey` values are retained after the GraphSnapshot
canonicalization (NFC text and normalized identifier separators). Edge identity
is the typed triple `from|kind|to`; JSON-LD additionally carries a deterministic
`cartograph:edge:sha256:<digest>` identifier and rejects a mismatched digest on
import. Evidence records are copied as structured records, including their
kind, repository-relative location, revision, reference, detector, content
hash, observation time, and count when present. An edge with no evidence is
valid only when it has an explicit `unresolvedReason`.

JSON-LD has an inline context and never asks a reader to retrieve a remote
context. The snapshot `@id` is a digest of the canonical snapshot, so a reader
can detect record tampering before accepting the document.

## Unsupported input and limits

The JSON, JSON-LD, and edge-list readers are strict. Unknown fields, unknown
record types, invalid identities, invalid evidence, duplicate/conflicting
records, unsupported schema versions, and malformed line structure fail with
`GraphInterchangeValidationError`; no field is silently ignored. The current
limits are 100,000 nodes, 200,000 edges, 50,000 diagnostics, and 16 MiB per
serialized artifact. Callers should review the error before retrying with a
narrower artifact.

This contract is an additive projection of GraphSnapshot v1. It does not change
the canonical snapshot, diff, query, or compiler-backed analyzer contracts.
CARTOGRAPH owns the graph, report, policy, reconciliation, and portable
interchange boundaries.
