# Runtime trace budgets

O-013 publishes the versioned `cartograph.runtime-trace-budgets` result in
schema version `1`. It is the bounded import boundary for optional local
runtime evidence. The importer accepts the O-001 OTLP JSON format, applies the
O-003 redaction policy before returning data, and never creates a temporary
file, starts a collector, contacts a network, or executes repository code.

## Hard limits and diagnostics

Every policy has explicit ceilings for input bytes, resource spans, scope
spans, spans, attributes per resource/scope/span record, trace count, analysis
time, and serialized normalized-trace report bytes. A malformed input, an
invalid policy, or any hard ceiling violation fails closed with a
`RuntimeTraceBudgetError` and a stable code. No partial result is returned for
an input, cardinality, time, or report-size failure.

The `reportBytes` field is the UTF-8 size of the canonical redacted normalized
trace payload that the report would carry. The size check happens after
redaction and any permitted trace selection, so sensitive text cannot evade the
budget or be measured into a retained artifact.

## Explicit deterministic truncation

The default `overflow` is `fail-closed`. A caller may explicitly select
`truncate-incomplete` for the trace-count ceiling. The importer then retains
the lowest trace IDs in canonical order, emits a `trace-count-truncated`
diagnostic, and reports `coverage.complete: false` together with input,
retained, and dropped trace/span counts. Truncation can never be reported as
complete coverage, and all other limits remain fail-closed.

The selected trace is redacted before it is returned. O-001 has already removed
arbitrary attributes, events, links, payloads, and status messages; O-003 then
redacts the remaining configured free-text fields. The budget result carries
`redacted: true` and `tempFiles: false` as machine-checkable invariants.

Validate the schema, sample, deterministic truncation, stable diagnostics,
redaction negative fixture, and offline boundary with:

```sh
npm run runtime-trace-budgets:validate
```

The published schema and sample are
[`schema/runtime-trace-budgets.v0.1.schema.json`](../schema/runtime-trace-budgets.v0.1.schema.json)
and
[`schema/runtime-trace-budgets.v0.1.json`](../schema/runtime-trace-budgets.v0.1.json).
