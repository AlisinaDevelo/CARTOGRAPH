# Compatibility and versioning

CARTOGRAPH treats snapshots and diffs as machine-readable contracts. Their
version is independent from the npm package version so a package patch release
cannot silently change an artifact's meaning.

The current contract inventory is in
[`schema/compatibility.json`](../schema/compatibility.json), and the canonical
GraphSnapshot shape is in
[`schema/graph-snapshot.v0.1.schema.json`](../schema/graph-snapshot.v0.1.schema.json).
The canonical GraphDiff shape is published in
[`schema/graph-diff.v0.1.schema.json`](../schema/graph-diff.v0.1.schema.json);
its summary counts are derived from the canonical change arrays and checked by
the runtime validator.
The extractor capability and unknown-semantics registry is versioned separately
in [`schema/capability-registry.v0.1.json`](../schema/capability-registry.v0.1.json)
and its JSON Schema.
Unsupported-construct definitions are versioned in
[`schema/diagnostic-registry.v0.1.json`](../schema/diagnostic-registry.v0.1.json)
and its JSON Schema; every analyzer diagnostic resolves to a registered code,
severity, source-span evidence contract, and actionable remediation.
Digest-bound policy bundles use the independent `policyBundles` contract in the
same manifest and are defined by
[`schema/policy-bundle.v0.1.schema.json`](../schema/policy-bundle.v0.1.schema.json).
Their digest-only migration reports use the reviewed `policyBundleMigrations`
contract and [`schema/policy-bundle-migration.v0.1.schema.json`](../schema/policy-bundle-migration.v0.1.schema.json).
Assurance signing records use the reviewed `assuranceSigning` contract and
[`schema/assurance-signing.v0.1.schema.json`](../schema/assurance-signing.v0.1.schema.json).
Remediation suggestion records and reports use the reviewed
`remediationSuggestions` contract and
[`schema/remediation-suggestion.v0.1.schema.json`](../schema/remediation-suggestion.v0.1.schema.json).
The deterministic rule catalog uses the reviewed `remediationRules` contract
and [`schema/remediation-rules.v0.1.schema.json`](../schema/remediation-rules.v0.1.schema.json).
Human remediation review records use the reviewed `remediationReviews`
contract and [`schema/remediation-review.v0.1.schema.json`](../schema/remediation-review.v0.1.schema.json).
Offline remediation evaluation reports use the reviewed `remediationEvaluations`
contract and [`schema/remediation-evaluation.v0.1.schema.json`](../schema/remediation-evaluation.v0.1.schema.json).
Local ADR reference indexes use the reviewed `adrReferences` contract and
[`schema/adr-reference.v0.1.schema.json`](../schema/adr-reference.v0.1.schema.json).
Policy evaluation reports use the reviewed `policyEvaluations` contract and
[`schema/policy-evaluation.v0.1.schema.json`](../schema/policy-evaluation.v0.1.schema.json).
Composed local policy metadata uses the reviewed `policyCompositions` contract
and [`schema/policy-composition.v0.1.schema.json`](../schema/policy-composition.v0.1.schema.json).
Local adapter requests, capability manifests, and graph results use the reviewed
`adapters` contract and [`schema/adapter.v0.1.schema.json`](../schema/adapter.v0.1.schema.json).
Normalized local OTLP JSON traces use the reviewed `runtimeTraces` contract and
[`schema/runtime-traces.v0.1.schema.json`](../schema/runtime-traces.v0.1.schema.json).
Static/runtime edge classifications use the reviewed `runtimeReconciliation`
contract and
[`schema/runtime-reconciliation.v0.1.schema.json`](../schema/runtime-reconciliation.v0.1.schema.json).
Redaction and bounded local retention use the reviewed `runtimeTraceSafety`
contract and
[`schema/runtime-trace-safety.v0.1.schema.json`](../schema/runtime-trace-safety.v0.1.schema.json).
Bounded runtime imports and explicit incomplete trace selection use the reviewed
`runtimeTraceBudgets` contract and
[`schema/runtime-trace-budgets.v0.1.schema.json`](../schema/runtime-trace-budgets.v0.1.schema.json).

## Change categories

- **Additive:** an optional field, enum value, diagnostic, or report detail that
  old readers can ignore without changing existing meaning.
- **Breaking:** a required field, removed field, changed identity, changed
  meaning, or incompatible output shape. This requires a new major contract
  version and a compatibility review.
- **Deprecated:** a still-readable field or value retained for one documented
  compatibility window and excluded from new output.
- **Migration-required:** a deterministic rewrite or explicit reader migration
  is required before an artifact can be consumed safely.

The same categories apply to snapshots, diffs, reports, policies, adapters, and
policy bundles. A policy bundle's compatibility block must match the graph,
diff, capability, and bundle versions accepted by the importer.

## Reader and writer rules

Writers emit only the current version. Readers accept only versions listed in
the manifest's `supportedReaders` set. An unknown or retired version fails with
an actionable migration error; it is never silently treated as the current
version. A migration belongs in [`schema/migrations/`](../schema/migrations/)
and must include representative fixtures and a review decision.

The GraphSnapshot v0.1 runtime currently reads version `1`. GraphDiff v0.1
also uses version `1`. Snapshots and diffs expose capability registry version
`1`; a registry mismatch fails closed before a diff or report is produced. The
JSON Schema and runtime validator must change together; the compatibility check
rejects drift between them.

## D-003 initial diff publication

D-003 publishes the existing GraphDiff v0.1 contract as a standalone JSON
Schema and makes its machine-readable summary explicit. Writers emit stable
counts for added, removed, and changed nodes, edges, and diagnostics; the
runtime rejects a summary that disagrees with the change arrays. The golden
valid and malformed fixtures exercise both the JSON Schema and runtime
validator, while repeated canonical serialization is required to be byte
identical. This is the first published diff artifact contract; no prior
standalone GraphDiff JSON Schema was shipped.

## Change control

`npm run schema:compatibility` verifies the manifest, runtime constants, and
published JSON Schema. It also rejects an unreviewed current-version entry.
`npm run check` runs this command, so the required CI checks fail closed when a
schema version changes without the manifest and review/migration record being
updated. Hosted checks are a separate environment; the same command is the
local replacement when they are unavailable.

## X-008 additive review

X-008 adds the `AMBIGUOUS_PACKAGE_CONDITION` diagnostic and documents package
`exports`/`imports` condition evidence in the capability and diagnostic
registries. This is an additive registry entry: version `1` remains current,
existing readers can ignore the new diagnostic code, and no snapshot shape or
migration is required. The merged implementation and its Node16/NodeNext
fixtures were re-run through the full local compatibility and test gates.

## D-007 additive review

D-007 extends GraphDiff v0.1 with optional classification fields on changed
nodes, edges, and diagnostics plus an optional `edges.rewired` derived view.
Existing added/removed/changed arrays and summary counts retain their v0.1
meaning, so readers that ignore the new fields remain compatible. Writers emit
deterministic classifications and pair only unambiguous endpoint rewires;
ambiguous candidates remain ordinary set differences. The published JSON
Schema, runtime validator, and golden fixtures are checked together.

## D-010 additive identity review

D-010 adds an optional `identity` section to GraphDiff v0.1. It records
refactor-aware matches and explicit ambiguous candidates while retaining the
existing node, edge, diagnostic, and summary arrays. Unique matches suppress
false node add/remove pairs; ambiguous nodes remain conservative add/remove
records. P-010 distinguishes equal-score ambiguity with
`AMBIGUOUS_IDENTITY_MATCH`, non-mutual destination contention with
`IDENTITY_COLLISION`, weak rename candidates with
`UNSUPPORTED_IDENTITY_RENAME`, and supported non-stable-key matches with
`IDENTITY_FALLBACK_MATCH`. Each emitted record carries deterministic evidence
for the candidates or signals a reviewer must inspect. The section, identity
method/signal enums, and diagnostic registry entries are additive for readers
that ignore them. Runtime canonicalization, the published JSON Schema, and
golden diff fixtures are checked together.

## D-013 additive revision-comparison review

D-013 adds an optional `comparison` section to GraphDiff v0.1. It records the
requested base and head references, their exact resolved commits, the selected
comparison mode, and—when using merge-base semantics—the unique resolved merge
base. Direct comparisons retain the existing two-tree behavior; merge-base
comparisons make pull-request-style three-dot behavior explicit. The field is
optional, so readers that ignore it retain the prior diff meaning, and no
contract version or migration is required. The runtime, JSON Schema, reports,
CLI, and fixtures reject shallow repositories, unrelated histories, and
ambiguous merge bases without fetching remote history.

## P-003 local policy configuration

P-003 publishes the versioned local policy contract in
`schema/policy.v0.1.schema.json` and `src/core/policy.ts`. It is intentionally
data-only: bounded node, edge, and diff selectors, four assertions, and an
informational-by-default mode. Unknown fields, executable expressions, URLs,
and out-of-repository policy paths fail closed. The runtime parser, local
evaluation command, and CI exit boundary are deterministic and offline; policy
composition, exceptions, and hosted export remain additive follow-on contracts.

## P-004 policy evaluation

P-004 publishes the versioned local evaluation report in
`schema/policy-evaluation.v0.1.schema.json` and
`src/core/policy-evaluation.ts`. It evaluates structured node, edge, and diff
rules over canonical snapshots or diffs, emits one deterministic violation per
failing rule with stable IDs, reasons, matched IDs, and evidence references,
and records unsupported diff-target rules on snapshot input explicitly. It is
read-only and offline; CI exit behavior and enforcing workflow integration are
reserved for P-005.

## P-014 policy composition

P-014 adds the reviewed `policyCompositions` v1 contract and the additive
composition fields in `schema/policy.v0.1.schema.json`. Repository-local
includes, scopes, precedence, duplicate IDs, override limits, cycles, and
contradictory outcomes are resolved deterministically and fail closed with
evidence-linked configuration errors. Existing v0.1 policy readers may ignore
the optional fields and continue to read single-file policies; composition
writers emit the separate v1 metadata contract and never resolve remote files.

## P-007 local ADR references

P-007 publishes a versioned local ADR reference index in
`schema/adr-reference.v0.1.schema.json` and `src/core/adr.ts`. Each bounded
record identifies an in-repository Markdown file, title, lifecycle status, and
one or more graph IDs. The runtime checks file metadata and optional graph
snapshot membership offline, reporting missing, malformed, stale, and
uncovered references deterministically. This is an additive new contract; ADR
lifecycle transitions, report rendering, and policy binding remain follow-on
roadmap work.

## O-001 local OpenTelemetry import

O-001 publishes runtime trace schema version `1` in
`src/core/runtime-traces.ts`. The importer accepts only a local OTLP JSON
export, applies bounded byte/cardinality limits, and normalizes spans into a
deterministic artifact. It retains identity, timing, service/scope names, span
kind, and status; arbitrary attributes, events, links, payloads, and status
messages are discarded. Duplicate identities, invalid IDs/timestamps, inverted
time ranges, malformed JSON, and limit violations fail closed.

This is an additive input contract, not runtime reconciliation. There is no
collector, upload, network access, module loading, repository-code execution,
retention policy, or report integration in O-001.

## O-002 static/runtime edge reconciliation

O-002 publishes runtime reconciliation schema version `1` in
`src/core/runtime-reconciliation.ts`. It compares explicit trace/span-to-node
bindings with static parent/child graph endpoints and emits deterministic
`observed-and-modeled`, `modeled-not-observed`, `observed-but-unmodeled`, and
`ambiguous` records. Every record links static evidence and/or trace
provenance, preserves an explicit uncertainty value, and is sorted by a stable
ID. Missing or duplicate bindings fail closed; no span name or arbitrary trace
attribute is used to guess a static node.

O-002 is a local, inert contract layered on the O-001 normalized input. It adds
no collector, upload, network access, retention, redaction, CLI, report, or
automatic binding behavior.

## O-003 runtime trace safety

O-003 publishes runtime trace safety schema version `1` in
`src/core/runtime-trace-safety.ts`. The default policy redacts every retained
free-text field after O-001 has discarded arbitrary attributes, events, links,
payloads, and status messages. A caller may choose a bounded subset of the
enumerated fields and replacement string, but cannot provide executable or
regular-expression policy logic.

`RuntimeTraceRetentionStore` retains only redacted normalized traces in memory,
with explicit `maxTraces`, `maxBytes`, and `ttlMs` bounds. It supports
`memory-only` and `discard-after-read` modes, deterministic oldest-entry
eviction, and explicit clearing. It never writes files, starts a collector, or
implicitly invokes reconciliation. O-003 is additive; the O-001 and O-002
artifact contracts remain version `1`.

## O-013 runtime trace budgets

O-013 publishes runtime trace budget result schema version `1` in
`src/core/runtime-trace-budgets.ts`. The importer composes O-001's bounded OTLP
normalizer with O-003's redaction boundary and adds explicit input-byte,
resource/scope/span, per-record attribute, trace-count, analysis-time, and
serialized-report ceilings. Every malformed input or hard ceiling violation
fails closed with a stable diagnostic code.

Trace-count overflow is fail-closed by default. The only permitted alternative
is an explicit `truncate-incomplete` policy, which retains the lowest canonical
trace IDs, emits a diagnostic, and sets `coverage.complete` to `false` with
dropped trace/span counts. Redaction occurs before report sizing and no result
creates temporary files or contacts a collector. This additive contract does
not enable automatic collection, binding, CLI integration, or hosted runtime
evidence.

## E-001 adapter API and capability manifest

E-001 publishes adapter API version `1` in `src/core/adapters.ts`. The
request/result types are structured JSON contracts: a request carries a local
source root, repository-relative selectors, JSON-only configuration, and
resource limits; a result carries a canonical GraphSnapshot, evidence,
diagnostics, and the producing capability manifest. `runAdapter` validates the
declared and returned manifests and fails closed on mismatches.

The v0.1 execution policy permits only source-read-only or no filesystem access
and requires network, child processes, dynamic module loading, and repository
code execution to be false. The sample adapter and validator are local,
deterministic, and offline. This is an additive new contract; framework
adapters, isolation sandboxes, and runtime-specific resource enforcement remain
follow-on work.
