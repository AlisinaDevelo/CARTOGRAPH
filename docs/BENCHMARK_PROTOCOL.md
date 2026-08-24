# Benchmark corpus and measurement protocol

CARTOGRAPH's benchmark corpus is selected by
[`benchmarks/corpus.v0.1.json`](../benchmarks/corpus.v0.1.json), and the
machine-readable measurement rules are in
[`benchmarks/protocol.v0.1.json`](../benchmarks/protocol.v0.1.json).

## Corpus governance

The corpus is a versioned set of repository-authored fixtures. Each entry names
its root, optional TypeScript configuration, construct families, and optional
checked-in expected artifact. The runner hashes sorted repository-relative paths
and file bytes with SHA-256. Results contain the digest and file counts, never
source bodies, snippets, absolute paths, network data, or hidden telemetry.
Changes to fixture selection, expected records, or the protocol require a new
protocol/corpus version and a review note.

## Runs and disclosure

For each fixture, the runner records one cold run (the first invocation in a
fresh benchmark process) and configurable warm runs (subsequent invocations in
that process). It reports minimum, median, p95, and maximum duration plus the
largest observed resident-set memory sample. Results disclose package version,
Node version, platform, architecture, CPU count, and total memory. The runner
makes no network requests and emits no telemetry.

## Accuracy

When an entry has an expected artifact, the runner compares canonical edge and
diagnostic identities. Precision is true-positive emitted records divided by
all emitted records. Recall is true-positive records divided by all expected
records. Expected artifacts can additionally declare construct-family selectors
over edge kinds, endpoint prefixes, and diagnostic codes; the runner reports
precision and recall for every declared family. Selectors may overlap when one
record represents more than one family. Unsupported or unresolved constructs
outside the declared expected subset are reported as diagnostics and do not
become silently supported claims. The benchmark test executes the evaluator
against the checked-in corpus so an unexpected edge, diagnostic, or family
score fails the local pipe.

## Variance gate

The baseline records the same corpus digest and protocol version as every later
run. A result more than 20% slower than the baseline requires an explanation
before release; this is a review threshold, not a universal performance
guarantee. Hardware and runtime differences must remain visible in the artifact.
