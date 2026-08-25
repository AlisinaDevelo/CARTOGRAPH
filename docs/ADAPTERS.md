# Adapter contract

CARTOGRAPH adapters are local, versioned implementations of a narrow graph
boundary. The public v0.1 contract is defined in
[`src/core/adapters.ts`](../src/core/adapters.ts) and its capability-manifest
schema in [`schema/adapter.v0.1.schema.json`](../schema/adapter.v0.1.schema.json).

An adapter receives a structured request containing a local source root,
repository-relative include and exclude paths, JSON configuration, and finite
resource limits. It returns a canonical `GraphSnapshot`, evidence, diagnostics,
and the manifest for the adapter that produced the result. `runAdapter` parses
both sides, canonicalizes the graph, enforces the request and response budgets,
verifies evidence and diagnostic declarations, and rejects a result whose
manifest does not match the declared adapter.

The execution declaration is intentionally fail-closed. Adapters may declare
`source-read-only` or `none` filesystem access, but network requests, child
processes, dynamic module loading, and repository-code execution are all
forbidden in v0.1. Configuration is JSON data only; executable-looking keys
and non-JSON values are rejected. This boundary describes authority and
compatibility; it does not grant an adapter access to the caller's process.

The deterministic fixture implementation in
[`src/adapters/sample.ts`](../src/adapters/sample.ts) is the reference adapter
for the conformance kit. Its empty, supported, unsupported, and identity cases
exercise the request/result path without executing repository code or contacting
a remote service.

```ts
const output = runAdapter(adapter, {
  apiVersion: 1,
  source: { rootDir: "/path/to/repository", include: ["."], exclude: [] },
  config: { fixture: "empty" },
  resources: {
    maxFiles: 20_000,
    maxFileBytes: 2_097_152,
    maxSourceBytes: 67_108_864,
    maxInputBytes: 8_388_608,
    maxOutputBytes: 33_554_432,
    maxMemoryBytes: 536_870_912,
    maxWallClockMs: 30_000,
  },
});
```

### Isolated execution

`runAdapter` is the in-process contract checker. An adapter supplied by a
third party must instead be hosted with `runAdapterIsolated`, which accepts a
local module URL and sends only the parsed JSON request over stdin. The host
starts a separate Node process with the permission model enabled: it grants
read access only to the declared source root and adapter module directory, and
does not grant writes, network, child processes, or worker creation. The
adapter's manifest is returned through the protocol and compared with the
validated output before any result is accepted.

The host enforces `maxInputBytes`, `maxOutputBytes`, `maxMemoryBytes`, and
`maxWallClockMs`. A timeout, response overflow, permission denial, malformed
protocol, or malformed evidence fails closed. Breaches terminate the child and
the host waits for its `close` event before returning the error; no adapter
process is left running after a rejected request.

```ts
const output = await runAdapterIsolated({
  adapterModule: new URL("./adapter.mjs", import.meta.url),
  input: {
    apiVersion: 1,
    source: { rootDir: "/path/to/repository", include: ["."], exclude: [] },
    config: {},
    resources: {
      maxFiles: 20_000,
      maxFileBytes: 2_097_152,
      maxSourceBytes: 67_108_864,
      maxInputBytes: 8_388_608,
      maxOutputBytes: 33_554_432,
      maxMemoryBytes: 536_870_912,
      maxWallClockMs: 30_000,
    },
  },
});
```

The isolation host is deliberately a local, opt-in boundary. It does not
execute repository code, infer permissions from an adapter's claims, or turn a
manifest into an authority grant. A deployment that cannot provide both the
Node permission model and its network-denial flag must refuse isolation rather
than silently fall back to an unbounded in-process adapter; the validator
reports that runtime as unavailable.

`npm run adapter:validate` validates the published manifest and request schema,
runs the sample adapter, invokes `runAdapterConformance`, and exercises the
isolated host against hangs, oversized output, malformed evidence, path
escapes, denied network and child-process access, and cleanup after termination.
The kit fails
closed unless every case has valid canonical output, deterministic
serialization across repeated runs, complete top-level evidence references,
capability-declared diagnostics, and a bounded runtime. An identity pair must
preserve the expected matches and must not silently turn them into added or
removed nodes; unsupported cases must emit an explicitly declared warning or
error diagnostic. The validator also proves that unsafe execution declarations
and executable configuration are rejected.

The adapter API, compatibility version, capability IDs, diagnostic codes, and
execution policy are versioned together. A contract or behavior failure is a
blocking validation error rather than a warning; adapters may add new
capabilities only with new fixtures and a reviewed compatibility decision.
Framework and language-specific adapters remain separate implementations behind
this boundary.
