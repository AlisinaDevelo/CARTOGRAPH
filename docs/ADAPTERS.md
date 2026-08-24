# Adapter contract

CARTOGRAPH adapters are local, versioned implementations of a narrow graph
boundary. The public v0.1 contract is defined in
[`src/core/adapters.ts`](../src/core/adapters.ts) and its capability-manifest
schema in [`schema/adapter.v0.1.schema.json`](../schema/adapter.v0.1.schema.json).

An adapter receives a structured request containing a local source root,
repository-relative include and exclude paths, JSON configuration, and finite
resource limits. It returns a canonical `GraphSnapshot`, evidence, diagnostics,
and the manifest for the adapter that produced the result. `runAdapter` parses
both sides, canonicalizes the graph, and rejects a result whose manifest does
not match the declared adapter.

The execution declaration is intentionally fail-closed. Adapters may declare
`source-read-only` or `none` filesystem access, but network requests, child
processes, dynamic module loading, and repository-code execution are all
forbidden in v0.1. Configuration is JSON data only; executable-looking keys
and non-JSON values are rejected. This boundary describes authority and
compatibility; it does not grant an adapter access to the caller's process.

The no-op implementation in [`src/adapters/sample.ts`](../src/adapters/sample.ts)
is a conformance fixture. It reads no files and produces an empty graph, so
the adapter validator can exercise the complete request/result path without
executing repository code or contacting a remote service.

```ts
const output = runAdapter(adapter, {
  apiVersion: 1,
  source: { rootDir: "/path/to/repository", include: ["."], exclude: [] },
  config: { fixture: "empty" },
  resources: {
    maxFiles: 20_000,
    maxFileBytes: 2_097_152,
    maxSourceBytes: 67_108_864,
    maxWallClockMs: 30_000,
  },
});
```

`npm run adapter:validate` validates the published manifest, runs the sample
adapter, checks canonical serialization, and proves that an unsafe execution
declaration is rejected. Framework and language-specific adapters remain
separate implementations behind this boundary.
