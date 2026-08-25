# Evaluation strategy

CARTOGRAPH evaluates extraction as a measurable program-analysis system, not by whether a graph looks persuasive.

## Fixture corpus

Each curated fixture contains source, an expected canonical graph, and an explanation of unsupported or ambiguous constructs. The governed corpus contains five fixtures spanning simple modules, project references, imports, routers, middleware, and dynamic or unsupported cases. License, source, reference, transformation, and local redistribution metadata are maintained in the [fixture provenance manifest](../test/fixtures/provenance.json) and checked by `npm run fixtures:validate`. The initial families are:

1. local imports and re-exports;
2. named functions, class methods, and resolved calls;
3. direct Express routes, router registrations, middleware, and handler references;
4. literal outbound HTTP calls;
5. conventional Prisma reads and writes;
6. dynamic or unresolved negative cases.

Fixtures test observable contracts. They do not assert internal traversal order.

## Correctness metrics

For each construct family, the evaluator reports:

- edge precision;
- edge recall;
- endpoint-to-sink path accuracy where a path is defined;
- unresolved-edge and unsupported-diagnostic rates;
- diagnostic-code coverage, evidence completeness, and remediation guidance;
- evidence completeness;
- source-location accuracy.

The first release target is at least 0.90 precision and 0.85 recall for explicitly supported constructs, with 100% evidence or an explicit unresolved reason on emitted edges. Results outside the declared subset do not count as supported merely because the analyzer emits something plausible. The benchmark evaluator runs these expected records in the local test pipe, including family-level precision and recall, so unexpected changes fail before publication.

## Determinism

CI analyzes the same fixture with varied discovery order and asserts byte-identical canonical JSON. Cross-platform fixtures normalize separators and exclude absolute paths, timestamps, temporary directories, and nondeterministic identifiers.

## Diff evaluation

Mutation fixtures introduce one known change at a time: an endpoint, dependency, data access, outbound request, removal, rename, cycle, or unresolved construct. The graph-diff golden fixture also combines the contract-level added, removed, changed, endpoint-rewire, evidence-only, confidence-change, and unresolved-diagnostic cases so the semantic categories cannot regress while individual analyzer fixtures evolve. Rewire pairing fails closed when multiple candidates are equally plausible, and golden diffs must remain stable under unrelated graph ordering changes while retaining evidence from the correct revision.

Impact traversal uses a hand-authored reachability fixture with a cycle, an
unresolved edge, and a known depth boundary. Forward and reverse runs assert
the exact node and edge sets, confidence/evidence preservation, cycle paths,
unresolved-edge visibility, depth-limit reporting, ordering stability, and a
bounded local timing sample. No network or source execution is involved.

Q-004 adds the six-scenario
[`architecture-impact/scenarios.v0.1.json`](../test/fixtures/architecture-impact/scenarios.v0.1.json)
golden corpus and the `cartograph.architecture-impact-evaluation` report.
The scenarios cover reverse callers and route boundaries, policy/runtime
boundaries, depth limits, resolved-only traversal, unsupported change kinds,
and explicit edge-kind selection. The report compares expected and observed
affected sets, precision, recall, categorized overreach, path reasons, and
reviewer-visible uncertainty. The current synthetic corpus has 16 expected
affected records, 18 observed records, precision `0.8889`, recall `1.0`, and
two declared overreach records (one boundary stop and one unresolved edge).
Those numbers describe this checked-in fixture only; they are not a population
risk estimate or a universal impact guarantee. Validate it with
`npm run impact:validate`.

Identity fixtures cover a source-line move, a unique same-name file move, a
rename supported by an unchanged directed neighborhood, duplicate-name
ambiguity, a non-mutual destination collision, and a weak unsupported rename.
They assert the match method and confidence, preserve explicit ambiguity
instead of guessing, retain ambiguous and unsupported nodes conservatively in
the added/removed sets, and serialize identically when node and edge input
order changes. D-010 adds a path-history rename diff, stable ambiguity
diagnostics, and a candidate-ceiling failure fixture. P-010 additionally
asserts deterministic `IDENTITY_COLLISION`, `UNSUPPORTED_IDENTITY_RENAME`,
and `IDENTITY_FALLBACK_MATCH` diagnostics, with one evidence record per
candidate or contributing signal and reviewer remediation text. P-001 is the
core primitive; D-010 and P-010 consume its matches in the graph-diff pipeline.

P-011 adds the bounded seeded corpus at
[`identity-corpus/scenarios.v0.1.json`](../test/fixtures/identity-corpus/scenarios.v0.1.json).
The xorshift32 seed is checked in alongside minimized regressions for line
moves, file moves, supported renames, duplicate names, overloads, normalized
path aliases, and ambiguous destination transformations. Each generated case
asserts one-to-one accounting, conservative ambiguity, and order-independent
serialization. `npm run identity:validate` publishes the seed, generated-case
count, match rate, ambiguity rate, and minimized-failure count; in CI it also
adds the result to the GitHub step summary.

P-012 adds the cross-platform corpus at
[`identity-portability/scenarios.v0.1.json`](../test/fixtures/identity-portability/scenarios.v0.1.json).
`npm run identity:portability:validate` compares Windows/POSIX separators,
NFC/NFD spellings, relocated repository roots, explicit case policy, and
symlink exclusion. Case-folded and Unicode collisions fail closed with
`IDENTITY_CASE_COLLISION` or `IDENTITY_UNICODE_COLLISION` diagnostics, and CI
publishes the portability result to the step summary.

P-013 adds the identity quality release gate in
[`IDENTITY_QUALITY.md`](IDENTITY_QUALITY.md). `npm run
identity:quality:validate` replays curated and seeded generated cases and
reports preservation, false-match, ambiguity, unmatched, and unsupported rates
by refactor family. It compares the deterministic quality digest with the
checked-in baseline and enforces the documented thresholds and expiring
exception process before release.

O-005 adds an uncertainty-aware runtime reconciliation corpus. Its complete,
head-sampled, and probabilistic cases preserve the same static/runtime oracle
while varying sampling metadata, clock precision, service aliases, and an
explicit missing parent. The local report records confidence separately from
classification and explains every classification or confidence change; an
unobserved span is never interpreted as absent behavior. The contract and
procedure are documented in
[`RUNTIME_RECONCILIATION_UNCERTAINTY.md`](RUNTIME_RECONCILIATION_UNCERTAINTY.md).

O-010 adds a separate family-labeled local runtime reconciliation corpus. Its
eight synthetic cases cover HTTP ambiguity, database reads, messaging
publication/subscription, error status, missing parents, sampling loss,
redaction, and static/runtime disagreement. Every case carries provenance and
exact expected classification IDs. `npm run runtime-reconciliation:corpus:validate`
replays the selected local spans and edges twice, checks deterministic
classifications and redaction, and publishes only input/trace/result digests;
the report explicitly records `network: false` and `exporter: false`. The
corpus is a controlled regression baseline, not a production workload or a
release threshold.

O-016 adds a reproducibility study over four selected O-010 cases. Five local
repetitions cover ordering, sampled-child, missing-parent, and redaction
perturbations; the digest-only report records stability, classification and
missingness ranges, and redaction invariants. The run is fully offline and
publishes explicit non-guarantees: its 20 stable replay digests do not estimate
production variance, exporter behavior, automatic binding quality, semantic
correctness, or completeness. Validate it with
`npm run runtime-reconciliation:reproducibility:validate`.

## Policy configuration evaluation

The policy fixture validates the versioned local contract through both the
published JSON Schema and the runtime parser. It covers node, edge, and diff
targets, count and presence assertions, informational defaults, unknown-field
rejection, selector bounds, deterministic serialization, and repository-local
file loading. A URL, executable field, or path outside the repository is
rejected before any evaluation boundary is reached. P-004 owns evaluation;
these fixtures do not claim that a valid policy has passed.

P-006 adds the checked-in
[`policy-regression.v0.1.json`](../test/fixtures/policy-regression.v0.1.json)
corpus. It contains positive and negative cases for every supported target and
assertion pair, an explicit diff-on-snapshot unsupported case, and assertions
for stable explanations and evidence references. `npm run
policy-regression:validate` evaluates the corpus twice, publishes the observed
false-positive, false-negative, explanation-regression, and evidence-regression
counts, and fails if any count differs from the checked-in baseline. The v0.1
baseline is zero for all four regression classes.

P-014 adds the offline policy-composition corpus at
[`policy-composition/scenarios.v0.1.json`](../test/fixtures/policy-composition/scenarios.v0.1.json).
It validates deterministic include order, scope-aware contradiction checks,
precedence and override authorization, duplicate IDs, cycles, duplicate
includes, contradictory outcomes, and remote-reference rejection. Every
negative case requires a typed configuration error with evidence references;
`npm run policy-composition:validate` also validates the composed result against
the published composition schema and checks repeated serialization for byte
identity.

P-015 adds the
[`policy-exceptions/scenarios.v0.1.json`](../test/fixtures/policy-exceptions/scenarios.v0.1.json)
corpus. It evaluates active, expiring, expired, malformed, and duplicate-
precedence records at a fixed `asOf` time in both informational and enforcing
modes. Only the selected active or expiring exception may suppress a matching
violation; expired and malformed records remain visible and leave the finding
intact. The validator checks report-schema conformance, evidence references,
expected suppression, and deterministic repeated evaluation.

P-018 adds the offline [policy and decision drift evaluation](POLICY_DECISION_DRIFT.md).
Its six curated scenarios compare expected and observed findings for ADR
supersession, removed architecture, policy changes, unreferenced additions,
exceptions, and mixed schema versions. The report publishes evidence-linked
findings, false-positive categories, reviewer minutes and steps, and the Year 2
Q3 milestone exit decision; `npm run policy-drift:validate` is a local release
gate.

E-007 adds a permission-boundary corpus for adapters. The isolated host is
replayed against a valid module, a non-cooperative hang, an oversized response,
malformed evidence, denied network and child-process requests, and a path
escape. The validator requires typed fail-closed errors, enforces
input/output/memory/time ceilings, and waits for terminated child processes to
close before accepting cleanup.

E-003 adds a bounded Fastify framework corpus selected through the public
[framework-selection RFC](https://github.com/AlisinaDevelo/CARTOGRAPH/issues/270).
It covers literal direct routes, object-form routes, method arrays, plugin
registration context, dynamic paths and methods, and an unresolved handler.
The adapter publishes route coverage and unknown diagnostics while keeping
plugin execution, hooks, decorators, and runtime-generated registration
explicitly unsupported.

E-004 adds the
[`language-neutral/compatibility.v0.1.json`](../test/fixtures/language-neutral/compatibility.v0.1.json)
fixture. Its Rust and Python snapshots exercise opaque language metadata,
portable one-based source coordinates, SHA-256-bound source evidence, an edge
with an explicit unresolved reason, and registered unknown diagnostics. The
language-neutral test also moves a Rust node to a Python path to prove identity
matching uses generic semantic signals rather than a TypeScript assumption,
then checks the existing sample and Fastify adapters under the same graph
contract.

E-008 adds the
[`adapter-compatibility/scenarios.v0.1.json`](../test/fixtures/adapter-compatibility/scenarios.v0.1.json)
corpus. It covers both shipped adapter IDs under the current API, a legacy
adapter-compatibility migration, experimental opt-in, and a future capability
registry rejection. The tests prove negotiation runs before `analyze`, applies
only the reviewed version rewrite, and preserves deterministic failure guidance.

E-009 adds the package-shaped
[`examples/adapter-starter`](../examples/adapter-starter) and its independent
root review harness. Three cases cover empty output, an evidence-backed
supported edge, and an explicit unsupported diagnostic. `npm run
adapter-starter:validate` validates the fixture schema, package dry-run,
repeated conformance output, compatibility negotiation, unsafe
authority/config/path rejection, and isolated execution (or the documented
unavailable-runtime refusal). The review stages, ownership, maintenance,
security response, and graduation threshold are recorded in the
[adapter review playbook](ADAPTER_REVIEW_PLAYBOOK.md).

E-006 adds the public [adapter selection RFC](ADAPTER_SELECTION.md) and the
[adapter support matrix](../schema/adapter-support-matrix.v0.1.json). The
matrix records implemented, experimental, deferred, and unsupported entries,
bounded support claims, owners and backups, compatibility dimensions, and
retirement triggers. `npm run adapter:support:validate` checks the versioned
schema, all status rows, shipped adapter manifests, repository references, and
the digest-bound documentation before the normal local check.

E-005 adds the bounded Rust pilot evaluation. The synthetic Rust fixture has
9 expected supported edges across module/function, local-call, literal HTTP,
and literal SQL categories. The local evaluator compares the complete edge
key set rather than only minimum counts: 9 true positives out of 9 predicted
and 9 expected edges gives precision 1.00 and recall 1.00. Dynamic HTTP and
dynamic SQL cases are counted as the two expected unsupported diagnostics, not
as false negatives. Every emitted edge and diagnostic must retain source
evidence, and the adapter's manifest denies network, child-process, dynamic
loading, and repository-code execution. These metrics do not generalize to
Rust constructs outside the named pilot slice.

E-010 adds the versioned
[`language-equivalence/scenarios.v0.1.json`](../test/fixtures/language-equivalence/scenarios.v0.1.json)
corpus and its
[`language-equivalence.v0.1.schema.json`](../schema/language-equivalence.v0.1.schema.json)
contract. `npm run language-equivalence:validate` analyzes the paired
TypeScript and Rust fixtures and reports conformance by semantic category:
modules, calls, boundaries, identity, evidence, and unknown behavior. The
v0.1 run has six cases, five equivalent projections, one intentionally
different unknown projection, complete source-bound evidence, and two
language-agnostic identity matches. Rust declaration-containment edges,
confidence vocabulary, detector identities, and Rust-specific dynamic-query
diagnostics are declared differences rather than mismatches. Any drift in a
declared node/edge count, diagnostic set, evidence minimum, or identity result
fails with the affected category and case, so the corpus remains a local
release gate even when hosted Actions are unavailable.

E-011 adds the versioned [adapter retirement and security-response policy](ADAPTER_RETIREMENT.md),
its [`adapter-lifecycle.v0.1.schema.json`](../schema/adapter-lifecycle.v0.1.schema.json)
contract, and two timed tabletop fixtures. The abandoned-adapter case covers
owner loss, quality review, deprecation notice, migration, and archive while
preserving historical snapshots and evidence. The security-defect case covers
private intake, containment, advisory, fix/replay, and coordinated disclosure.
`npm run adapter:lifecycle:validate` checks ownership, vulnerability fields,
stable/experimental/unreleased windows, precision/recall/evidence triggers,
notice/archive/replacement requirements, ordered deadlines, public templates,
and source-leak guards. Both cases pass with ten deterministic events.

E-012 adds the digest-bound [language-expansion gate report](LANGUAGE_EXPANSION_GATE.md)
and public [ADR 0006](adr/0006-language-expansion-gate.md). The report compares
predeclared conformance, semantic coverage, unknown rate, precision, recall,
performance, maintenance cost, demand, security ownership, and evidence
completeness for the bounded Rust pilot. The measured quality and safety floors
pass, but no independent demand signal is recorded, so the decision retains
the pilot as experimental and keeps broad `language.rust` expansion deferred
with zero implementation commitments.

E-018 adds the offline [adapter compatibility matrix](ADAPTER_COMPATIBILITY_MATRIX.md).
It binds the declared Node and compiler lines, checks every shipped adapter
capability against bounded fixtures with deterministic evidence, replays all
four compatibility-negotiation states, and runs schema-compatibility and
upgrade-policy subchecks. CI supplies `CARTOGRAPH_MATRIX_NODE` from its Node
matrix; a local runtime outside that window is reported rather than silently
treated as a supported combination.

## Practical compatibility

R-005 records the first compatibility review in
[`COMPATIBILITY_REVIEW.md`](COMPATIBILITY_REVIEW.md). It analyzes three public
TypeScript repositories successfully and retains two additional public runs as
bounded failures, publishing supported, unknown, and failed counts without
copying third-party source or graph snapshots. The checked-in aggregate record
also links feedback to follow-up roadmap issues; `npm run
compatibility:validate` fails if commits, digests, totals, or failure boundaries
drift.

## Performance

The governed corpus and measurement rules live in the
[benchmark protocol](BENCHMARK_PROTOCOL.md). The checked-in baseline records
cold and warm scan time, peak memory, graph size, and accuracy denominators
without copying source bodies or telemetry. A regression greater than 20%
requires an explanation before release; this is a review threshold, not a
universal performance guarantee. CI runs `npm run benchmark:ci` against a
temporary artifact so correctness, determinism, schema, and the applicable
performance gate are checked without rewriting the baseline.

M-002 adds the offline [bounded property and security corpus](PROPERTY_TESTING.md),
which replays seeded TypeScript, snapshot, policy, and adapter cases under an
explicit runtime ceiling and keeps discovered crash or security boundaries as
ordered regression fixtures.

## Human usefulness

Design-partner evaluation measures whether reviewers can correctly explain a reported change, reach its evidence, and distinguish facts from unresolved analysis. Downloads and graph size are not success metrics.
