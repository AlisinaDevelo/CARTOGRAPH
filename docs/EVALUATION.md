# Evaluation strategy

CARTOGRAPH evaluates extraction as a measurable program-analysis system, not by whether a graph looks persuasive.

## Fixture corpus

Each curated fixture contains source, an expected canonical graph, and an explanation of unsupported or ambiguous constructs. License, source, reference, transformation, and local redistribution metadata are maintained in the [fixture provenance manifest](../test/fixtures/provenance.json) and checked by `npm run fixtures:validate`. The initial families are:

1. local imports and re-exports;
2. named functions, class methods, and resolved calls;
3. direct Express routes and handler references;
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
- evidence completeness;
- source-location accuracy.

The first release target is at least 0.90 precision and 0.85 recall for explicitly supported constructs, with 100% evidence or an explicit unresolved reason on emitted edges. Results outside the declared subset do not count as supported merely because the analyzer emits something plausible.

## Determinism

CI analyzes the same fixture with varied discovery order and asserts byte-identical canonical JSON. Cross-platform fixtures normalize separators and exclude absolute paths, timestamps, temporary directories, and nondeterministic identifiers.

## Diff evaluation

Mutation fixtures introduce one known change at a time: an endpoint, dependency, data access, outbound request, removal, rename, cycle, or unresolved construct. Golden diffs must classify the expected change and retain evidence from the correct revision.

## Practical compatibility

Before v0.1, CARTOGRAPH will analyze at least three representative public TypeScript repositories or recorded snapshots. The report will publish supported, unresolved, and failed construct counts without copying third-party source into the repository.

## Performance

Benchmarks record cold scan time, peak memory, graph size, diff time, and report size on small, medium, and large tiers. A later incremental cache may record warm scan time. A regression greater than 20% requires an explanation before release; this is a review threshold, not a universal performance guarantee.

## Human usefulness

Design-partner evaluation measures whether reviewers can correctly explain a reported change, reach its evidence, and distinguish facts from unresolved analysis. Downloads and graph size are not success metrics.
