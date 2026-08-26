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
Q-007 adds optional deterministic pagination to the architecture query v1
request and result projections. Writers emit page size, total/returned counts,
`hasMore`, and opaque cursors bound to the canonical snapshot and normalized
query; readers that do not use pagination retain the unpaged default. Cursor
validation fails closed with an explicit diagnostic, and no match is silently
discarded. This is additive to the v1 contract and does not require a schema
version or migration change.
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

## X-012 API schema boundaries

X-012 adds bounded GraphQL SDL/template and OpenAPI operation discovery to the
TypeScript analyzer without changing GraphSnapshot, GraphDiff, adapter, or
capability versions. GraphQL root fields and OpenAPI path methods use stable
`endpoint` identities; a resolver or handler reference becomes an inferred
`routes_to` edge only when it resolves to one local callable or a matching
literal framework endpoint. Source spans and SHA-256 hashes cover the schema
declaration and the resulting relationship.

Generated schema inputs, aliased or referenced operations, missing mappings,
and runtime-composed routes remain visible as the stable
`PARTIAL_API_SCHEMA_GENERATION`, `PARTIAL_API_SCHEMA_ALIAS`, and
`PARTIAL_RUNTIME_COMPOSED_ROUTE` diagnostics. The analyzer never executes a
schema generator, follows a remote reference, or guesses a runtime route.

## X-013 Prisma schema boundaries

X-013 adds bounded `.prisma` schema discovery without changing graph, diff,
adapter, capability, or diagnostic versions. Datasources are `service` nodes,
models retain the existing `database_table:prisma:<Model>` identity, relations
are `depends_on` edges, and supported generated clients are `module` nodes with
schema-file evidence. Existing Prisma operation edges receive the matching model
schema evidence when a declaration is available.

Multiple schema files, duplicate declarations, unsupported providers or
generators, and generated output paths outside the repository remain explicit
diagnostics. The analyzer performs no database connection, network access, or
Prisma generation.

## X-016 lockfile dependency provenance

X-016 adds bounded, read-only lockfile discovery without changing graph, diff,
adapter, capability, or diagnostic versions. At the repository root and declared
workspace package roots, npm `package-lock.json`, pnpm `pnpm-lock.yaml`, Yarn
`yarn.lock`, and JSON Bun `bun.lock` records are normalized into deterministic
dependency evidence. Internal workspace names reuse `package` nodes; other names
become external `module` nodes. Every emitted relationship retains a lockfile
source span and content hash.

Unsupported lockfile versions, manager mismatches, missing integrity/checksum
metadata, multiple manager files, malformed JSON, and Bun binary `bun.lockb`
files remain explicit diagnostics. The analyzer performs no network access,
package-manager execution, dependency installation, or binary lockfile decoding.

## X-017 generated-code provenance

X-017 adds generated-code classification and exclusion diagnostics without
changing GraphSnapshot, GraphDiff, adapter, capability, or diagnostic versions.
Selected TypeScript files are classified from generated directory names,
filename conventions, explicit generated markers, and configured
generated-looking exclusions. Their existing `module:<path>` identity remains
stable while the node language is `typescript-generated`. A bounded
`cartograph:generated-from=<path>` marker creates a `depends_on` edge from the
generated module to the selected local source module and carries the generated
file's source span and content hash.

Generated source files excluded by a detected directory or configured
generated-looking pattern remain visible as `EXCLUDED_GENERATED_FILE` info
diagnostics. Each message includes the exact repository-relative path and the
reason for exclusion. An explicit source marker that cannot resolve to a
selected in-repository source produces `GENERATED_SOURCE_UNRESOLVED`. The
detector is read-only, resource-bounded, deterministic, and never runs a code
generator. These additions are additive to the v0.1 graph and diagnostic
contracts; consumers that do not inspect the new language or diagnostic codes
retain the prior record shape.

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

## W-001 offline workspace composition

W-001 publishes the additive
[`cartograph.workspace-composition`](../schema/workspace-composition.v0.1.schema.json)
manifest contract. A manifest names a bounded set of independently produced
local snapshots by repository identity, logical name, immutable revision,
repository-relative path, GraphSnapshot schema version, adapter identity and
version, and declared byte size. Optional boundaries and explicit omissions
make missing repositories visible without pretending that their graphs were
loaded.

The parser rejects duplicate identities and paths, incompatible schema or
adapter major versions, absolute/parent-traversing/URI paths, snapshots or
collections above declared resource limits, unknown boundary endpoints, and
implicit remote inputs. Reading a manifest performs only bounded local file
I/O; it never fetches a repository, embeds source, executes code, or opens a
network path. Existing GraphSnapshot, GraphDiff, adapter, and diagnostic
consumers are unchanged.

## W-002 cross-repository identity namespaces

W-002 publishes the additive
[`cartograph.workspace-identity`](../schema/workspace-identity.v0.1.schema.json)
composition contract. It normalizes explicit Git origin references into stable
transport-independent namespaces and prefixes every local node stable key with
that namespace. Local checkout paths are metadata only, so relocation does not
change identity. Fork metadata is retained as a relationship and never treated
as permission to merge independently produced snapshots.

Canonical origin duplicates, origin/repository alias collisions, and logical-name
collisions are deterministic ambiguity records. Ambiguous namespaces retain each
underlying snapshot and receive a repository disambiguator rather than silently
coalescing nodes. Missing origin metadata is explicit `origin-unavailable`
evidence with a repository-scoped fallback namespace. The composition is
read-only, bounded by repository/node/ambiguity limits, does not fetch or open a
network path, and preserves canonical local snapshots for later boundary
resolution.

## W-003 declared cross-repository boundaries

W-003 publishes the additive
[`cartograph.workspace-boundaries`](../schema/workspace-boundaries.v0.1.schema.json)
v1 contract. The local resolver accepts materialized GraphSnapshots, explicit
package/service declarations, and selected manifest, source, lockfile,
service-catalog, runtime, or user evidence. Exact declaration names, aliases,
optional repository aliases, and exact requested versions are required before
an edge is emitted; multiple candidates remain `ambiguous`.

Targets are classified as `resolved`, `ambiguous`, `external`, `unavailable`, or
`unsupported`. Omitted repositories and version mismatches remain unavailable,
while external targets must be explicitly marked. Resolved edges include
provenance from both repositories; unresolved records include a reason and any
candidate evidence. Monorepo-local edges and deterministic cross-repository
cycle summaries are additive report data. The resolver is bounded, read-only,
offline, and does not rewrite GraphSnapshot identities.

## W-004 provenance-aware incremental workspace recomposition

W-004 publishes the additive
[`cartograph.workspace-recomposition`](../schema/workspace-recomposition.v0.1.schema.json)
contract. Requests and cache entries carry canonical SHA-256 input state across
content, contract, adapter, policy, workspace, and tool dimensions. A unit's
key includes only its declared inputs; upstream unit dependencies are checked
separately. A changed input therefore invalidates only proven dependents rather
than the entire portfolio, while missing, corrupt, forged, or workspace-mismatched
caches fail closed.

Cold, warm, partial-change, corrupt-cache, and interrupted-write fixtures are
validated locally. Warm plans reuse byte-identical results, partial plans retain
unrelated units, and stale cache entries are omitted from the next cache. Cache
writes are bounded and local, reject symlinks and path escapes, and use a
same-directory temporary file plus atomic rename. An interruption cannot replace
the previous cache and leaves no temporary state. The contract does not fetch
repositories, execute package managers, upload source, or infer dependencies
not declared by the caller.

## W-005 workspace privacy and resource boundaries

W-005 publishes the additive
[`cartograph.workspace-privacy`](../schema/workspace-privacy.v0.1.schema.json)
contract. It is the explicit execution boundary for a composed workspace:
repository count, aggregate graph cardinality, raw/compressed/expanded bytes,
depth, observed time and memory, cache size, report size, path exposure,
optional runtime metadata, decompression ratio, and temporary entries are all
bounded by versioned defaults that callers may lower but cannot raise above
the published maxima.

The default is fail-closed and local-only. Raw paths and runtime metadata are
disabled unless an explicit mode and limit are supplied; digest-only paths are
safe to retain, while relative paths are checked for traversal, URI, control,
and symbolic-link escapes. Credential-shaped metadata is rejected without
including the value in a diagnostic. Mixed trust requires explicit isolation,
and partial repository failures are reported only as an explicit `partial`
assessment. Temporary workspace helpers always remove their directory in a
`finally` path, including callback failures. Existing graph, composition,
identity, boundary, and recomposition readers remain additive and unchanged.

## M-014 telemetry-free adoption measurement

M-014 publishes the versioned, aggregate-only
[`cartograph.adoption-measurement`](../schema/adoption-measurement.v0.1.schema.json)
protocol and its
[`protocol.v0.1.json`](../test/fixtures/adoption-measurement/protocol.v0.1.json)
snapshot. It defines six metrics whose only eligible inputs are opt-in public
reports, issue-template signals, release metadata, manually reproducible local
repository runs, and consented anonymized summaries. The current snapshot
retains five pinned technical-sample records and defers every adoption or
traction claim.

The protocol is governance evidence, not a runtime or GraphSnapshot field. It
requires no network, source upload, account, raw-input retention, personal
data, or hidden telemetry. Sampling bias, missingness, retention, minimum-cell
anonymization, consent withdrawal, and deletion responsibilities are explicit;
changing the metric meaning or source authorization requires a new protocol
version and review rather than silently changing an existing snapshot.

## W-006 representative federation evaluation

W-006 publishes the additive
[`cartograph.workspace-federation-evaluation`](../schema/workspace-federation-evaluation.v0.1.schema.json)
report and its
[`report.v0.1.json`](../test/fixtures/workspace-federation-evaluation/report.v0.1.json)
fixture. It replays three pinned sanitized portfolios across package,
service, schema, missing-repository, version-skew, and cross-boundary-change
scenarios. Resolution precision and recall, unknown coverage, identity
stability, incremental performance, reviewer-usefulness missingness, and
privacy findings are explicit and recomputed by an offline validator.

The current evidence supports a narrow local aggregate replay only. The report
does not change GraphSnapshot, GraphDiff, workspace identity, boundary,
recomposition, or privacy versions and does not make a population-level
accuracy, performance, adoption, certification, or reviewer-usefulness claim.

## E-017 SCIP import and export

E-017 adds the additive
[`cartograph.scip-interchange`](../schema/scip-interchange.v0.1.schema.json)
v1 JSON projection for already-produced SCIP indexes. Documents, symbols,
occurrences, relationships, tool/version metadata, CARTOGRAPH stable keys, and
portable evidence references have deterministic mappings to GraphSnapshot
nodes, edges, and evidence. The checked-in
[`round-trip.v0.1.json`](../test/fixtures/scip-interchange/round-trip.v0.1.json)
proves that stable identities and extension evidence references survive import,
export, and re-import.

The boundary is local and source-free: absolute roots, file URIs, source-body
`text`, unknown fields, duplicate declarations, and over-limit indexes fail
closed. Fields without a canonical GraphSnapshot equivalent are reported with
stable `SCIP_*` codes and a preservation strategy; they are not silently
dropped. `npm run scip:validate` is the offline replay gate, and the contract
does not change GraphSnapshot, GraphDiff, or STRATA's compiler-backed semantic
analysis boundary.

## G-001 explicit ownership resolution

G-001 adds the reviewed additive `ownershipResolution` contract and
[`cartograph.ownership-resolution`](../schema/ownership-resolution.v0.1.schema.json)
v1 schema. The runtime accepts versioned local ownership rules and a bounded
CODEOWNERS subset, resolves only sources for the target repository, and emits
source/rule evidence for every matched result. Precedence, aliases, fallback,
rename handling, conflicts, unavailable owners, unknown references, and explicit
no-owner outcomes are part of the versioned result; no owner is inferred from a
name or path.

The checked-in
[`report.v0.1.json`](../test/fixtures/ownership-resolution/report.v0.1.json)
fixture is replayed by `npm run ownership:validate`. The contract is local and
offline, does not retain source bodies in reports, and does not change
GraphSnapshot, GraphDiff, or STRATA's compiler-backed semantic analysis
boundary.

## G-002 auditable finding lifecycle

G-002 adds the reviewed additive `findingLifecycle` contract and
[`cartograph.finding-lifecycle`](../schema/finding-lifecycle.v0.1.schema.json)
v1 schema. Findings carry stable identity, initial state, policy/evidence
revisions, and source-bound evidence. Digest-bound append-only events carry an
actor, timestamp, rationale, transition, sequence, and previous digest. The
runtime allows only the documented state transitions and fails closed for
invalid transitions, gaps, chain mismatches, concurrent conflicts, missing
identity-migration targets, and tampering.

The checked-in
[`replay.v0.1.json`](../test/fixtures/finding-lifecycle/replay.v0.1.json)
fixture covers identity migration, supersession, policy changes, removed
architecture, regression, concurrent records, and tampered events. Replay is
local and offline through `npm run finding-lifecycle:validate`; reports do not
include source bodies and the contract does not change GraphSnapshot, GraphDiff,
or STRATA's compiler-backed semantic analysis boundary.

## G-003 locally verifiable architecture waivers

G-003 adds the reviewed additive `architectureWaiver` contract and
[`cartograph.architecture-waiver`](../schema/architecture-waiver.v0.1.schema.json)
v1 schema. A waiver binds one policy rule, exact selector, canonical input
digest, affected graph identities, policy/evidence revisions, rationale,
distinct owner and approver, expiry, and explicit local trust roots. Optional
Ed25519 signature metadata is digest-bound and verified through the local
assurance-signing contract; private keys and authority are never part of the
record or report.

Verification is fail-closed and offline. Malformed, unsigned, tampered,
broadened, replayed, stale, expired, revoked, untrusted, or otherwise invalid
records remain visible and cannot suppress policy enforcement. Suppression is
possible only for a fully verified exact-scope match, and every suppression and
provenance record carries `authorityGranted: false`. The checked-in
[`scenarios.v0.1.json`](../test/fixtures/architecture-waivers/scenarios.v0.1.json)
corpus is replayed with `npm run architecture-waivers:validate`; this additive
contract does not change GraphSnapshot, GraphDiff, or STRATA's compiler-backed
semantic analysis boundary.

## G-004 ownership and waiver drift

G-004 adds the reviewed additive `ownershipWaiverDrift` contract and
[`cartograph.ownership-waiver-drift`](../schema/ownership-waiver-drift.v0.1.schema.json)
v1 schema. It reads versioned ownership and waiver reports plus safe
digest-oriented key and waiver projections. Stable target identity makes
repository moves and owner reassignment visible; policy/evidence revision,
scope, expiry, signature, key-rotation, and partial-workspace changes are
diagnosed with stable `DRIFT_*` codes.

The report preserves prior decision-trail records and appends current
decisions. It never auto-extends a waiver, grants authority, includes source
bodies, or serializes signature/private-key material. The
[`scenarios.v0.1.json`](../test/fixtures/ownership-waiver-drift/scenarios.v0.1.json)
fixture is replayed by `npm run ownership-waiver-drift:validate`; the contract
is local, offline, deterministic, and additive. Readers that do not implement
the contract must retain the artifact as an unsupported report rather than
interpreting it as a clean review.

## G-005 review summaries

G-005 adds the versioned `reviewSummary` contract and
[`cartograph.review-summary`](../schema/review-summary.v0.1.schema.json) schema.
It is a presentation-layer request/report around an existing GraphDiff with
optional local lifecycle, ownership, waiver, waiver-drift, policy, ADR, and
artifact context. The report preserves declared identities, evidence
references, state and expiry, owner source, policy/ADR context, drift codes,
bounded counts, and non-mutating next steps. It does not alter GraphSnapshot or
GraphDiff and does not evaluate policy, verify signatures, infer ownership, or
grant authority.

Writers emit canonical JSON plus deterministic Markdown/HTML projections;
readers that do not implement the contract must retain it as unsupported rather
than treating missing context as clean. Input and output limits, repository-
relative artifact paths, source-body/private-key exclusion, and provenance
flags are part of the v1 reader/writer boundary. The checked-in scenarios are
replayed by `npm run review-summary:validate`; a future meaning change requires
a new review-summary version or an explicit migration review.

## G-006 review workflow evaluation

G-006 adds the reviewed report-only `reviewWorkflowEvaluation` contract and
[`cartograph.review-workflow-evaluation`](../schema/review-workflow-evaluation.v0.1.schema.json)
v1 schema. Its aggregate-only fixture derives seven bounded workflow metrics
and records six explicit abuse-case outcomes for forgery, replay, broad
waivers, owner spoofing, fork pull requests, and compromised keys. The
validator recomputes all measurements and security counts, binds the public
decision to a digest, and rejects source bodies, credentials, network access,
mutative commands, and absolute paths.

The current gate passes the synthetic thresholds but defers team-scale
workflow expansion because no independent maintainer study is present. This is
governance evidence only: it does not change GraphSnapshot, GraphDiff,
review-summary, ownership, waiver, signing, or Action wire shapes. A future
change to metric meaning requires a new evaluation version or an explicit
migration review. Replay it with `npm run review-workflow:evaluation:validate`.
