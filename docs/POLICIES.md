# Local policy configuration

CARTOGRAPH policy configuration is a versioned, repository-local JSON contract
for declaring bounded architecture constraints. The public v0.1 contract is
[`schema/policy.v0.1.schema.json`](../schema/policy.v0.1.schema.json), with a
representative example in [`schema/policy.v0.1.json`](../schema/policy.v0.1.json).

## Shape and selectors

A policy has a lower-case `policyId`, semantic `version`, optional `mode`, and
at least one rule. `mode` defaults to `informational`; the evaluator reports
violations with this effective mode, while CI exit behavior remains a separate
P-005 contract.

Rules are deliberately data-only. Each rule has an identifier, a target, a
selector, and an assertion:

- `node` selectors match an exact node `kind`, `id`, or `name`;
- `edge` selectors match an exact edge `kind`, `from`, or `to`;
- `diff` selectors match a bounded diff `kind`, `id`, diagnostic `code`, or
  change `classification`.

Assertions are `exists`, `absent`, `count-at-most`, and `count-at-least`.
Count assertions require a non-negative integer `value`; presence assertions
reject one. Rules may carry an explicit `effect`, while omitted effects remain
informational for compatibility with future evaluation.

Unknown fields, executable content, URLs, commands, and arbitrary selector
expressions are rejected. Selectors are bounded by field-specific enums and
length limits, so a policy cannot smuggle code or a remote authority into the
configuration.

## Offline loading

`parsePolicyConfig` validates an in-memory value. `readPolicyConfig` accepts only
a regular file inside the supplied repository root, applies a 1 MiB input
ceiling, parses JSON, and returns the same validated contract. It never reads
the declared `policyId` or any remote source, opens a network connection, or
executes a rule. `serializePolicyConfig` provides deterministic canonical JSON.

`evaluatePolicyOnSnapshot` and `evaluatePolicyOnDiff` consume canonical local
graphs and return the versioned
[`policy-evaluation`](../schema/policy-evaluation.v0.1.schema.json) report.
Snapshot input evaluates node and edge rules; diff input evaluates changed
node/edge records and diff records. A diff-target rule on a snapshot is
reported as explicit `unsupported-target` rather than silently ignored.
Every violation has a stable rule-based ID, deterministic reason, matched IDs,
and graph/evidence references. The evaluator never fetches a policy, opens a
network connection, executes a selector, or changes a graph. CI exit-mode
behavior remains the separate P-005 contract; a valid configuration or report
is not by itself authorization to merge.
