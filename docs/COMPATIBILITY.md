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
Local architecture query requests and results use the reviewed
`architectureQueries` contract and
[`schema/architecture-query.v0.1.schema.json`](../schema/architecture-query.v0.1.schema.json)
with result details in
[`schema/architecture-query-result.v0.1.schema.json`](../schema/architecture-query-result.v0.1.schema.json).
The v0.1 executor supports deterministic node and edge selection, direct
neighbors, bounded upstream/downstream reachability, shortest dependency paths,
boundary crossing, cycle enumeration, and an additive opt-in metadata
projection. The projection carries already-evaluated policy findings and
exceptions, ADR lifecycle references and diagnostics, explicit ownership hints,
and caller-declared unsupported metadata; it never evaluates policy or infers
an owner. Source-body search, remote queries, and mutation remain explicit
unsupported operations. Query artifacts remain local, read-only,
source-body-free, deterministic, and resource-bounded. This Q-003 addition is
additive to v0.1: callers that omit the projection retain the prior result
shape and semantics, while readers that ignore the optional metadata section
remain compatible.
Evidence-backed change-impact scenarios use the separately reviewed
`architectureImpacts` contract and
[`schema/architecture-impact.v0.1.schema.json`](../schema/architecture-impact.v0.1.schema.json).
The Q-004 scenario corpus and digest-bound evaluation report are test
artifacts defined by
[`schema/architecture-impact-fixtures.v0.1.schema.json`](../schema/architecture-impact-fixtures.v0.1.schema.json)
and
[`schema/architecture-impact-evaluation.v0.1.schema.json`](../schema/architecture-impact-evaluation.v0.1.schema.json).
They add no GraphSnapshot or GraphDiff fields: callers opt into explicit
change kinds, traversal allow-lists, boundary stops, evidence-linked reasons,
and visible unknowns. A future impact-model revision requires a new version or
an explicit migration review.
Inspectable query explanations use the separately reviewed
`architectureQueryExplanations` contract and
[`schema/architecture-query-explanation.v0.1.schema.json`](../schema/architecture-query-explanation.v0.1.schema.json).
The v0.1 explanation embeds query and result v1 records, normalized plans,
limits, evidence-aware paths, policy/ADR/ownership context, and explicit
uncertainty. JSON, Markdown, and HTML are projections of the same deterministic
object; changing its meaning requires a new explanation version or an explicit
migration review. The five-case fixture and evaluation schemas are
[`architecture-query-explanation-fixtures.v0.1.schema.json`](../schema/architecture-query-explanation-fixtures.v0.1.schema.json)
and
[`architecture-query-explanation-evaluation.v0.1.schema.json`](../schema/architecture-query-explanation-evaluation.v0.1.schema.json).
The Q-006 quality gate is a report-only governance contract at
[`architecture-query-quality-gate.v0.1.schema.json`](../schema/architecture-query-quality-gate.v0.1.schema.json).
It does not change GraphSnapshot, GraphDiff, query, impact, or explanation
wire shapes; it records threshold results and conservative scope decisions for
those existing v1 contracts. A future gate revision that changes metric
meaning requires a new report version or explicit migration review.
Local ADR reference indexes use the reviewed `adrReferences` contract and
[`schema/adr-reference.v0.1.schema.json`](../schema/adr-reference.v0.1.schema.json).
P-008 adds ADR comparison details only to Markdown and standalone HTML report
rendering; the canonical GraphDiff v1 JSON shape is unchanged, so existing
machine readers retain their compatibility boundary.
Policy evaluation reports use the reviewed `policyEvaluations` contract and
[`schema/policy-evaluation.v0.1.schema.json`](../schema/policy-evaluation.v0.1.schema.json).
Composed local policy metadata uses the reviewed `policyCompositions` contract
and [`schema/policy-composition.v0.1.schema.json`](../schema/policy-composition.v0.1.schema.json).
Expiry-bound local policy records use the reviewed `policyExceptions` contract
and [`schema/policy-exception.v0.1.schema.json`](../schema/policy-exception.v0.1.schema.json).
Local adapter requests, capability manifests, and graph results use the reviewed
`adapters` contract and [`schema/adapter.v0.1.schema.json`](../schema/adapter.v0.1.schema.json).
E-007 adds the additive bounded request schema in
[`schema/adapter-input.v0.1.schema.json`](../schema/adapter-input.v0.1.schema.json)
and an opt-in permissioned process host. The new input and output, memory, and
wall-clock ceilings default conservatively and are enforced before a result is
accepted; existing v0.1 manifest readers retain their meaning. A third-party
adapter cannot fall back silently to an unbounded in-process execution path.
Runtimes without an enforceable network-denial permission are reported as
unsupported for isolation rather than treated as equivalent.
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
The O-004 synthetic evaluation fixture and report are versioned test artifacts
defined by
[`schema/runtime-reconciliation-evaluation-fixtures.v0.1.schema.json`](../schema/runtime-reconciliation-evaluation-fixtures.v0.1.schema.json)
and
[`schema/runtime-reconciliation-evaluation.v0.1.schema.json`](../schema/runtime-reconciliation-evaluation.v0.1.schema.json).
They are not runtime inputs or outputs and do not change the O-002
`runtimeReconciliation` reader boundary; a future evaluation revision must
publish a new fixture/report version or an explicit migration review.
The O-010 corpus is likewise a versioned, local test artifact: its fixture and
digest-only report are defined by
[`schema/runtime-reconciliation-corpus-fixtures.v0.1.schema.json`](../schema/runtime-reconciliation-corpus-fixtures.v0.1.schema.json)
and
[`schema/runtime-reconciliation-corpus.v0.1.schema.json`](../schema/runtime-reconciliation-corpus.v0.1.schema.json).
It adds no runtime input fields, automatic binding behavior, exporter access, or
release threshold, and any future corpus contract revision must publish a new
version or an explicit review.
The O-016 reproducibility study is also a versioned local test artifact, defined
by
[`schema/runtime-reconciliation-reproducibility-fixtures.v0.1.schema.json`](../schema/runtime-reconciliation-reproducibility-fixtures.v0.1.schema.json)
and
[`schema/runtime-reconciliation-reproducibility.v0.1.schema.json`](../schema/runtime-reconciliation-reproducibility.v0.1.schema.json).
It adds no runtime input fields, automatic binding behavior, exporter access,
or production variance guarantee; a future study-contract revision must publish
a new version or an explicit review.

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

## D-009 additive topology review

D-009 adds an optional `topology` section to GraphDiff v0.1. It records
deterministic before/after cycle summaries, explicitly configured layer
assignments, layer-boundary violations, and unresolved or ambiguous layer
diagnostics. Cycle and violation records retain the contributing edge evidence
so reviewers can follow a summary back to canonical graph records. Existing
GraphDiff consumers that ignore the optional section retain their prior
semantics; no snapshot schema or capability-registry migration is required.
Layer selectors are never inferred from names or paths, and missing metadata
fails closed with `UNRESOLVED_LAYER_ASSIGNMENT` rather than inventing a layer.

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

## P-015 policy exceptions

P-015 adds the versioned `policyExceptions` record contract and optional
`exceptions` policy field. The evaluator reports lifecycle state and evidence
for every raw record, selects suppression deterministically by precedence, and
keeps expired or malformed records from suppressing findings. These are
additive fields and report details; readers that do not consume exceptions
retain the prior single-policy meaning, while current readers preserve unknown
records as visible malformed exceptions.

## P-007 local ADR references

P-007 publishes a versioned local ADR reference index in
`schema/adr-reference.v0.1.schema.json` and `src/core/adr.ts`. Each bounded
record identifies an in-repository Markdown file, title, lifecycle status, and
one or more graph IDs. The runtime checks file metadata and optional graph
snapshot membership offline, reporting missing, malformed, stale, and
uncovered references deterministically. P-016 adds additive lifecycle history,
effective-date, and supersession fields with deterministic transition and link
diagnostics; readers that ignore those optional fields retain the P-007 meaning.
Report rendering remains follow-on roadmap work. P-019 adds the separate
policy-binding contract described below.

## P-017 ADR coverage indexes

P-017 publishes additive ADR coverage schema version `1` in
`schema/adr-coverage.v0.1.schema.json`. Reports expose deterministic
ADR-to-graph and graph-to-ADR indexes for each compared snapshot, retaining
unresolved and ambiguous links and descriptive counts by node and edge kind.
Readers that do not render the optional coverage section retain the prior ADR
reference and GraphDiff v1 meaning.

## R-012 runtime support matrix

R-012 publishes the versioned runtime boundary in
`schema/support-matrix.v0.1.json` and checks it against package-lock and CI
metadata. The CLI accepts Node 22.13.0 or newer on Linux and macOS, while the
declared LTS and CI window remains Node 22.x and 24.x with TypeScript 6.0.3 and
ts-morph 28.0.0. An unsupported operating system or Node version fails closed
with `SUPPORT_MATRIX_UNSUPPORTED_ENVIRONMENT`; a newer compatible Node runtime
is reported as outside the declared LTS window rather than silently expanding
the support claim.

## P-019 policy ADR bindings

P-019 adds the versioned `policyAdrBindings` contract and the optional
`adrBindings` policy field. Boundary bindings require selected graph evidence
to be covered by a local ADR reference; exception and planned-violation
bindings require the matching expiry-bound exception to name that reference.
Missing, stale, malformed, and mismatched references become deterministic
evidence-linked policy violations and cannot authorize suppression. The CLI
accepts a repository-relative ADR index through `--adr`; no hosted lookup is
performed. This is additive to policy and evaluation v1 readers that ignore
the optional binding records.

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

## O-005 uncertainty-aware reconciliation

O-005 adds the versioned
`cartograph.runtime-reconciliation-uncertainty` report around O-002. It is
additive: readers that only understand O-002 may continue consuming the
original reconciliation artifact. The new report preserves O-002
classifications while adding sampling, clock, service-alias, missing-parent,
and confidence metadata. Sampling gaps are not absence claims, aliases do not
create bindings, and change explanations identify whether a difference comes
from sampling, clock precision, a missing parent, or binding confidence. The
offline validator and schemas are documented in
[`RUNTIME_RECONCILIATION_UNCERTAINTY.md`](RUNTIME_RECONCILIATION_UNCERTAINTY.md).

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

## E-003 Fastify framework adapter

E-003 adds `cartograph.fastify@0.1.0` behind the unchanged adapter result
contract. The bounded extractor recognizes literal Fastify route methods and
object-form route declarations, emits source evidence for endpoint-to-handler
edges, and reports dynamic methods/URLs or unresolved handlers as diagnostics.
The `fastify` extractor is opt-in in repository configuration; existing
TypeScript/Express defaults remain unchanged. Plugin execution, hooks,
decorators, schemas, and runtime-generated registration are not claimed.

## X-011 asynchronous relationship extraction

X-011 extends the existing TypeScript/Express extractor capability registry
without changing GraphSnapshot or GraphDiff versions. The bounded slice maps
literal `EventEmitter` publication and listener registration, Bull/BullMQ queue
publication and worker/process registration, timer and microtask callbacks, and
local callback parameters that are invoked by their callee to existing `queue`,
`publishes`, `subscribes`, and `calls` records. Registration and handler spans
remain separate source evidence records.

Dynamic event or queue names, string-only reflection, unsupported queue clients,
and unresolved handlers use the registered X-011 diagnostics. They do not emit a
guessed edge or execute source code. The synthetic
[`typescript-async`](../test/fixtures/typescript-async) fixture is the positive,
negative, and deterministic compatibility boundary for this additive capability.

## E-004 language-neutral semantic contract

E-004 documents the GraphSnapshot v1 contract independently of TypeScript in
[`LANGUAGE_NEUTRAL_SEMANTICS.md`](LANGUAGE_NEUTRAL_SEMANTICS.md). The
language-neutral boundary keeps node and edge kinds, stable-key identity,
portable one-based source coordinates, evidence requirements, and explicit
unknown semantics unchanged while adapters provide optional opaque language
metadata. The `languageNeutralSemantics` entry in
[`schema/compatibility.json`](../schema/compatibility.json) and the
`language-neutral` fixture provide a reviewed Rust/Python compatibility sample.

## E-005 bounded Rust adapter pilot

E-005 adds `cartograph.rust@0.1.0` without changing the adapter API, capability
registry version, or GraphSnapshot schema. The pilot is source-only and
regex-bounded: it recognizes Rust modules/functions, local `mod`/`use` imports
and unique local calls, literal `reqwest`/client HTTP origins, and literal
`sqlx` table reads/writes. Dynamic destinations, dynamic queries, unresolved
local modules, and qualified calls are stable diagnostics rather than guessed
edges. The support matrix therefore promotes `cartograph.rust` while keeping
the broader `language.rust` claim deferred. The fixture and local conformance
report record exact 1.00 precision and recall for the nine expected supported
edges; this result is not a universal Rust compatibility claim.

This is an additive documentation and fixture contract. Existing GraphSnapshot,
GraphDiff, capability, diagnostic, Express, and Fastify reader boundaries stay
at version `1`; no migration or runtime schema bump is required.

## E-010 cross-language semantic equivalence

E-010 publishes the
[`cartograph.language-equivalence`](../schema/language-equivalence.v0.1.schema.json)
contract and the paired TypeScript/Rust
[`scenarios.v0.1.json`](../test/fixtures/language-equivalence/scenarios.v0.1.json)
corpus. The evaluator runs both projections through their public analyzer
boundaries and compares declared node/edge counts, exact diagnostic-code sets,
source-bound evidence, and language-agnostic identity outcomes by semantic
category. The v0.1 baseline has six cases, five equivalent projections, one
intentional-difference unknown projection, complete evidence, and two identity
matches. Rust containment edges, confidence and detector vocabulary, and
Rust-specific dynamic-query diagnostics are versioned intentional differences;
they do not change GraphSnapshot v1 or the adapter API. `npm run
language-equivalence:validate` is the local compatibility gate and reports any
drift with its category and case.

## X-009 workspace package boundaries

X-009 adds an additive `package` node kind to the GraphSnapshot v1 vocabulary.
When a repository documents npm or Yarn `package.json` workspaces, or a pnpm
`pnpm-workspace.yaml`/`.yml`, the TypeScript analyzer discovers only declared,
repository-contained package roots. Each package node uses the stable relative
root (`package:<root>`) and its `package.json` as source location and evidence.
Local package dependencies become evidence-backed `depends_on` edges, while
analyzed source modules become `contains` edges owned by their nearest package.

Malformed manifests, duplicate package names, overlapping roots, mixed package
manager declarations, absolute patterns, and patterns that select no package
fail closed with an actionable `WorkspaceManifestError`; no unrelated package
root is merged. Discovery is deterministic, read-only, source-body-free, and
bounded by the analyzer resource policy. The new node kind is additive: existing
GraphSnapshot, GraphDiff, adapter, capability, and diagnostic versions remain at
`1`; older readers that do not understand package selectors can still preserve
the node and its edges as opaque graph records.

## E-011 adapter lifecycle and security response

E-011 publishes the versioned
[`cartograph.adapter-lifecycle`](../schema/adapter-lifecycle.v0.1.schema.json)
policy and the paired
[`adapter-lifecycle/scenarios.v0.1.json`](../test/fixtures/adapter-lifecycle/scenarios.v0.1.json)
tabletops. The contract is additive documentation and governance metadata; it
does not change GraphSnapshot, GraphDiff, adapter API, or capability versions.
It binds owner and backup responsibility, private vulnerability intake,
stable/experimental/unreleased support windows, quality regression triggers,
deprecation notice fields, archive preservation, and explicit replacement
guidance. The validator replays an abandoned-adapter timeline and a security-
defect timeline with ten bounded events and public communication templates;
deadlines and final states are deterministic, and source or secret disclosure
markers fail closed.

## E-012 language-expansion gate

E-012 publishes the digest-bound
[`cartograph.language-expansion-gate`](../schema/language-expansion-gate.v0.1.schema.json)
report and [ADR 0006](adr/0006-language-expansion-gate.md). The gate compares
predeclared conformance, semantic coverage, unknown rate, precision, recall,
performance, maintenance cost, demand, security ownership, and evidence
completeness for the bounded Rust pilot. Quality and safety floors pass, but
independent demand is absent, so `cartograph.rust` remains bounded and broad
`language.rust` expansion remains deferred with no implementation commitments.
The report and ADR are additive governance evidence; they do not change
GraphSnapshot, GraphDiff, adapter API, capability, or diagnostic versions.

## E-008 adapter compatibility negotiation

E-008 adds the reviewed `adapterCompatibilityNegotiation` v1 contract and
performs negotiation before adapter analysis. The report compares adapter API,
adapter compatibility, capability registry, and GraphSnapshot versions and
classifies the result as `compatible`, `migratable`, `experimental`, or
`rejected`. A rejected result includes deterministic failure guidance; an
experimental result requires explicit opt-in; and the only migratable path is a
bounded adapter compatibility `0 → 1` rewrite with a 2027-06-30 retirement
window. Current sample and Fastify manifests declare the stable v1 dimensions.

The registry, fixture schema, and five-case corpus are published in
[`schema/adapter-compatibility.v0.1.json`](../schema/adapter-compatibility.v0.1.json),
[`schema/adapter-compatibility-fixtures.v0.1.schema.json`](../schema/adapter-compatibility-fixtures.v0.1.schema.json),
and [`test/fixtures/adapter-compatibility/scenarios.v0.1.json`](../test/fixtures/adapter-compatibility/scenarios.v0.1.json).
The adapter result's optional negotiation record is additive; existing v0.1
manifest and graph readers retain their meaning.
