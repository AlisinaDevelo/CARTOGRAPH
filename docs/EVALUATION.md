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

## Practical compatibility

Before v0.1, CARTOGRAPH will analyze at least three representative public TypeScript repositories or recorded snapshots. The report will publish supported, unresolved, and failed construct counts without copying third-party source into the repository.

## Performance

The governed corpus and measurement rules live in the
[benchmark protocol](BENCHMARK_PROTOCOL.md). The checked-in baseline records
cold and warm scan time, peak memory, graph size, and accuracy denominators
without copying source bodies or telemetry. A regression greater than 20%
requires an explanation before release; this is a review threshold, not a
universal performance guarantee. CI runs `npm run benchmark:ci` against a
temporary artifact so correctness, determinism, schema, and the applicable
performance gate are checked without rewriting the baseline.

## Human usefulness

Design-partner evaluation measures whether reviewers can correctly explain a reported change, reach its evidence, and distinguish facts from unresolved analysis. Downloads and graph size are not success metrics.
