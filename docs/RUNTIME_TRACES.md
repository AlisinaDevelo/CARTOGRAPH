# Local runtime trace import

CARTOGRAPH v0.1 accepts one local runtime format: an OpenTelemetry Protocol
(OTLP) JSON `ExportTraceServiceRequest` with `resourceSpans`, `scopeSpans`, and
`spans`. `parseRuntimeTraceJson` parses the JSON text and returns the versioned
normalized contract in [`schema/runtime-traces.v0.1.schema.json`](../schema/runtime-traces.v0.1.schema.json).
It never starts a collector, contacts a URL, uploads data, imports a module, or
executes repository code.

Normalization retains only bounded structural fields needed by a future local
reconciliation pass: trace/span identity, parent identity, span name and kind,
nanosecond timestamps, service name, instrumentation scope, and status. IDs are
lower-case hexadecimal, timestamps are decimal strings, arrays are sorted
deterministically, and duplicate spans or inverted time ranges fail closed.
Resource, scope, and span attributes—including payloads, headers, and status
messages—are discarded rather than copied into the normalized artifact. The
summary records how many attributes were discarded.

The parser applies explicit limits to input bytes, resource spans, scope spans,
spans, and attributes per record. `parseRuntimeTraceJson` enforces the byte
limit before parsing; malformed JSON, malformed OTLP records, duplicate spans,
and limit violations return `RuntimeTraceValidationError` with a stable code.
The normalized artifact is in-memory only. O-003 adds the explicit field-level
redaction and bounded-retention boundary documented in
[`RUNTIME_TRACE_SAFETY.md`](RUNTIME_TRACE_SAFETY.md); CLI/report integration
remains a separate follow-on contract. O-013 adds the explicit bounded import
and cost policy documented in [`RUNTIME_TRACE_BUDGETS.md`](RUNTIME_TRACE_BUDGETS.md);
trace-count truncation is opt-in and always marked incomplete. The explicit local static/runtime
reconciliation contract is documented separately in
[`RUNTIME_RECONCILIATION.md`](RUNTIME_RECONCILIATION.md).

```ts
const normalized = parseRuntimeTraceJson(localOtlpJson, {
  maxBytes: 64 * 1024 * 1024,
  maxSpans: 100_000,
});
```

Run the offline conformance validator with `npm run runtime-traces:validate`.
The checked-in [OTLP fixture](../schema/runtime-traces-otlp.v0.1.json) includes
attributes and a status message that the normalized sample proves are absent.
