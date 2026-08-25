# Policy ADR bindings

Policy ADR bindings connect a selected policy boundary or planned exception to a
repository-local architecture decision. They keep a waiver from becoming a
free-form assertion: the policy names the ADR, the ADR names graph identities,
and evaluation checks both sides offline.

The binding contract is versioned in
[`schema/policy-adr-binding.v0.1.schema.json`](../schema/policy-adr-binding.v0.1.schema.json)
and is carried by the optional `adrBindings` array in
[`schema/policy.v0.1.schema.json`](../schema/policy.v0.1.schema.json):

```json
{
  "schemaVersion": 1,
  "contract": "cartograph.policy-adr-binding",
  "id": "core-boundary-adr",
  "ruleId": "core-boundary",
  "requirement": "boundary",
  "scope": {
    "target": "node",
    "selector": { "id": "module:src/core/index.ts" }
  },
  "referenceId": "ADR-0002"
}
```

`requirement` is one of:

- `boundary` requires every selected graph object to be covered by the named
  ADR's graph IDs.
- `exception` requires a matching active or expiring exception to carry the
  same `adrReferenceId`.
- `planned-violation` applies the same requirement to an explicitly planned
  violation and makes the intent visible in the evidence.

An exception may carry `adrReferenceId` as defined by
[`schema/policy-exception.v0.1.schema.json`](../schema/policy-exception.v0.1.schema.json).
When a binding requires it, a missing or different ID makes the exception
ineligible to suppress the policy finding.

## Evaluation

Provide the local ADR reference index explicitly:

```sh
cartograph policy . \
  --policy cartograph-policy.json \
  --snapshot graph-snapshot.json \
  --adr schema/adr-reference.v0.1.json
```

The CLI accepts only a repository-relative ADR index. It performs no network
lookup. Missing documents, missing references, malformed or stale ADR files,
stale graph IDs, and graph-scope mismatches are emitted as policy violations
with stable policy, binding, ADR, and graph evidence references. They never
silently pass and never authorize an exception. Informational mode still
returns the report without blocking; enforcing mode returns the normal finding
exit code.

ADR lifecycle transitions and supersession semantics are validated by the
additive P-016 lifecycle contract before binding evaluation. This binding still
only verifies that the named local reference exists, is current for the
evaluated graph where available, and covers the selected boundary; lifecycle
diagnostics remain visible and cannot authorize a binding.
