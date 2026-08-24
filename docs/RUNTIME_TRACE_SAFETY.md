# Runtime trace safety

O-003 publishes the local runtime trace safety policy in
`cartograph.runtime-trace-safety` schema version `1`. It is an explicit
redaction and bounded-retention boundary around the normalized O-001 input.

## Default redaction

O-001 already discards arbitrary OTLP attributes, events, links, payloads, and
status messages. O-003 additionally redacts every retained free-text field by
default: span name, service name, instrumentation scope name, and scope
version become `[REDACTED]`. A caller may select a subset of those enumerated
fields and a bounded replacement string; there are no user-supplied regular
expressions or executable policies. The default is deliberately conservative
because request paths, service names, and scope metadata can contain secrets or
identifiers even when attributes are absent.

`redactRuntimeTrace` returns a new canonical trace and never mutates its input.
The reconciler consumes only normalized trace structure and emits trace
identifiers as provenance references; it does not copy span names, service
metadata, payloads, headers, or arbitrary attributes into static snapshots,
reconciliation records, or reports.

## Bounded retention

`RuntimeTraceRetentionStore` is an in-memory-only store. The policy requires a
mode, maximum trace count, maximum serialized bytes, and a TTL:

- `memory-only` keeps a bounded redacted trace until TTL expiry or explicit
  `clear`;
- `discard-after-read` deletes the trace immediately after a successful read;
- expired entries are removed before reads and writes; and
- when a count or byte bound is reached, the oldest entry is evicted
  deterministically (timestamp, then identifier).

The default policy is 64 traces, 4 MiB, and 15 minutes. The checked-in fixture
uses two traces, 64 KiB, one second, and `discard-after-read` to exercise the
controls. Retention identifiers are non-path strings. No policy creates files,
opens a collector, uploads data, or starts background cleanup.

## Explicit opt-in

There is no default trace store, automatic collection, or reconciliation CLI.
A caller must explicitly import a local trace, apply a safety policy, retain it
in the bounded store if desired, and invoke reconciliation. The safety policy
does not grant authority to execute repository code or contact a network.

Validate the policy, sensitive-value negative fixture, retention bounds, and
offline boundary with:

```sh
npm run runtime-trace-safety:validate
```

The published policy schema and sample are
[`schema/runtime-trace-safety.v0.1.schema.json`](../schema/runtime-trace-safety.v0.1.schema.json)
and [`schema/runtime-trace-safety.v0.1.json`](../schema/runtime-trace-safety.v0.1.json).
