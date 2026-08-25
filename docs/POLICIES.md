# Local policy configuration

CARTOGRAPH policy configuration is a versioned, repository-local JSON contract
for declaring bounded architecture constraints. The public v0.1 contract is
[`schema/policy.v0.1.schema.json`](../schema/policy.v0.1.schema.json), with a
representative example in [`schema/policy.v0.1.json`](../schema/policy.v0.1.json).

## Shape and selectors

A policy has a lower-case `policyId`, semantic `version`, optional `mode`, and
at least one rule. `mode` defaults to `informational`; the evaluator reports
violations with this effective mode. A policy may also declare a bounded local
`scope`, numeric `precedence`, an `overrideLimit`, and repository-relative
`includes`. These fields are composed offline before evaluation; no include can
fetch a URL or leave the repository. The `cartograph policy` command and the
GitHub Action expose the same explicit CI modes: informational reports findings
and returns 0, while enforce returns 2 for violations or unsupported rules and
reserves 1 for tool or configuration errors.

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

## Offline composition

`includes` names regular JSON policy files relative to the analyzed repository
root. Composition visits each file once in canonical path order, detects cycles
and duplicate includes, and applies fixed bounds for include depth, file count,
and rule count. A rule identifier is unique across the composition. Identical
duplicates are coalesced; a differing lower-precedence definition is accepted
only when the higher-precedence policy's `overrideLimit` authorizes it. Equal
precedence disagreements and unauthorized overrides are configuration errors.
The `scope` participates in contradiction grouping, so otherwise identical
selectors in different scopes remain independent.

Contradictory assertions for one scope, target, and selector (for example,
`exists` and `absent`) are rejected. Every composition error is a typed,
offline configuration error with stable source paths and evidence references
for the involved policy files, rule IDs, scopes, or composition limit. The
serialized composition records the root, all sources, and authorized overrides
so a reviewer can reproduce the result without remote resolution.

## Expiry-bound local exceptions

P-015 adds the versioned `cartograph.policy-exception` record. Each exception
names one rule and a bounded node, edge, or diff selector, then records a
single-line rationale, lower-case owner identifier, creation time, mandatory
expiry, and deterministic precedence. Exceptions are retained in the policy
input as raw records so malformed records remain visible to evaluation instead
of becoming an invisible parse failure.

Evaluation classifies every record as `active`, `expiring`, `expired`, or
`malformed`. Active and expiring exceptions can suppress a matching violation;
when several apply, the highest precedence wins and ties use the stable
exception ID. Expired, malformed, unknown-rule, future-created, and
target-mismatched exceptions never suppress findings. Their report entries
carry policy, exception, rule, and input evidence references. The same
exception semantics apply in informational and enforcing modes; mode controls
the CI exit status, while lifecycle state remains visible in both reports.

The `cartograph policy` command accepts `--as-of <date-time>` for reproducible
expiry evaluation and `--exception-window-days <days>` (default seven) for the
expiring classification boundary. No exception grants merge authority or
performs a policy mutation.

## Policy ADR bindings

P-019 adds the versioned `cartograph.policy-adr-binding` record through the
optional `adrBindings` array. A `boundary` binding requires every selected
graph object to be covered by the named local ADR reference. `exception` and
`planned-violation` bindings require a matching active or expiring exception to
carry the same `adrReferenceId`. Missing documents, missing or stale
references, malformed records, and graph-scope mismatches become stable policy
violations with ADR and graph evidence; they never silently authorize
suppression.

Pass the repository-relative reference index with `cartograph policy --adr
<path>`. Binding evaluation is offline and does not infer ADR approval or
contact a hosting service. The
[`policy ADR binding guide`](POLICY_ADR_BINDINGS.md) and
[`policy-adr-binding fixture corpus`](../test/fixtures/policy-adr-bindings/scenarios.v0.1.json)
document the complete positive and fail-closed cases.

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
network connection, executes a selector, or changes a graph. The Action is
disabled unless a policy path is supplied; its default policy mode is
informational and enforcement is opt-in. A valid configuration or report is not
by itself authorization to merge.

## Regression corpus

The offline
[`policy-regression.v0.1.json`](../test/fixtures/policy-regression.v0.1.json)
corpus exercises positive and negative outcomes for every supported
`target:assertion` pair. It also checks the explicit unsupported result for a
diff-target rule evaluated against a snapshot, stable explanation text, and
evidence references. `npm run policy-regression:validate` runs every case twice
and publishes the expected baseline counts; the checked-in v0.1 baseline is
zero false positives, zero false negatives, zero explanation regressions, and
zero evidence regressions.

The policy-composition fixture at
[`policy-composition/scenarios.v0.1.json`](../test/fixtures/policy-composition/scenarios.v0.1.json)
covers deterministic includes, scope isolation, authorized precedence, duplicate
IDs, override limits, equal-precedence conflicts, cycles, duplicate includes,
contradictory outcomes, and rejected remote references. `npm run
policy-composition:validate` runs every positive and negative scenario through
both the runtime contract and the published composition schema.

The policy-exception fixture at
[`policy-exceptions/scenarios.v0.1.json`](../test/fixtures/policy-exceptions/scenarios.v0.1.json)
covers active, expiring, expired, malformed, and precedence-selected records in
informational and enforcing modes. `npm run policy-exceptions:validate` checks
the exception schema, evaluation report schema, evidence, suppression rules,
and repeated serialization.

The policy ADR binding fixture at
[`policy-adr-bindings/scenarios.v0.1.json`](../test/fixtures/policy-adr-bindings/scenarios.v0.1.json)
covers valid, missing, stale, mismatched, and planned-exception references.
`npm run policy-adr-bindings:validate` checks both binding and ADR schemas,
policy evaluation findings, graph evidence, suppression behavior, and repeated
serialization.
