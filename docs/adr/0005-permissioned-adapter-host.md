# ADR 0005: Execute third-party adapters behind a permissioned host

- Status: accepted
- Date: 2028-05-01
- Decision: proceed

## Context

The v0.1 adapter manifest describes a deliberately narrow authority boundary,
but an in-process JavaScript function cannot be killed when it hangs and does
not by itself prevent a module from attempting network, filesystem, or child
process access. Resource fields also need an enforcement point rather than a
documentation-only promise.

## Decision

Accept the additive adapter request schema and the opt-in
`runAdapterIsolated` host. The host sends only canonical JSON to a separate
Node process, enables the Node permission model, grants read access only to
the declared source root and adapter module directory, and leaves writes,
network, child processes, and worker creation denied. It enforces input,
output, memory, and wall-clock ceilings. A permission denial, protocol error,
malformed evidence, or budget breach fails closed; a breach kills the child and
waits for its close event before returning.

`runAdapter` remains the synchronous contract checker for trusted local
fixtures. It now applies the same serialization, evidence, diagnostic, and
wall-clock checks but is not a substitute for the isolated host. Deployments
that cannot provide the permissioned process boundary must not silently fall
back to unbounded third-party execution.

## Consequences

Adapters must be exported from a local file module and return JSON-compatible
results. The process boundary adds startup cost and requires a supported Node
permission model, but it makes hangs, oversized responses, path escapes,
malformed evidence, denied network access, and cleanup behavior reviewable in
offline conformance tests. This decision grants no remote authority and does
not execute repository source.
