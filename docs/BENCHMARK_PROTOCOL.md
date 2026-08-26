# Benchmark corpus and measurement protocol

CARTOGRAPH's benchmark corpus is selected by
[`benchmarks/corpus.v0.1.json`](../benchmarks/corpus.v0.1.json), and the
machine-readable measurement rules are in
[`benchmarks/protocol.v0.1.json`](../benchmarks/protocol.v0.1.json).
The versioned tier ceilings are in
[`benchmarks/budgets.v0.1.json`](../benchmarks/budgets.v0.1.json) and are
validated by `npm run benchmark:budgets:validate`.

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

## Small, medium, and large budgets

The baseline is divided into three bounded tiers so a fast small fixture cannot
hide a large-fixture regression:

- **Small tier:** `outside-import` and `exclusions`; p95 runtime is capped at
  250 ms, peak RSS at 750,000,000 bytes, and serialized report size at 40,000
  bytes.
- **Medium tier:** `review-regressions` and `project-loader`; p95 runtime is
  capped at 250 ms, peak RSS at 900,000,000 bytes, and serialized report size at
  60,000 bytes.
- **Large tier:** `typescript-express`, the largest bounded checked-in fixture;
  p95 runtime is capped at 800 ms, peak RSS at 1,000,000,000 bytes, and
  serialized report size at 100,000 bytes. This is a local budget ceiling, not
  a claim that the fixture represents every production repository size.

For each tier, both cold and warm p95 runtime and peak RSS are recorded for every
fixture. `reportBytes` is the UTF-8 size of the deterministic serialized graph
snapshot. The budget validator requires every corpus fixture to belong to one
and only one tier and fails closed when any recorded metric exceeds its tier.

## Bounded revision-diff workloads

`benchmarks/diff-workloads.v0.1.json` declares deterministic synthetic revision
workloads for the small, medium, and large supported tiers. Each workload states
the before/after node and edge cardinality, edge density, renamed-node count, and
allowed identity ambiguity. The generated snapshots are held only in memory;
the checked-in `benchmarks/diff-baseline.v0.1.json` retains the workload-manifest
digest, graph cardinalities, identity metrics, diff summary counts, serialized
report size, wall-time samples, peak RSS, and runtime/hardware disclosure. It
contains no generated node, edge, evidence, or source payload.

`npm run benchmark:diff:validate` regenerates the declared shape and fails closed
if a workload exceeds its tier's node, edge, density, ambiguity, p95, memory, or
report-size ceiling. `npm run benchmark:diff:ci` repeats each workload, checks
deterministic diff summaries and digest identity, and applies the same 20%
median-time variance band as the scan benchmark. An environment mismatch is
reported explicitly and skips the timing comparison unless
`--require-compatible-environment` is supplied.

## CI gate

`npm run benchmark:budgets:validate` checks the three tier budgets, p95 runtime,
peak RSS, report size, and the 20% explanation rule before the gate runs.
`npm run benchmark:ci` runs a fresh cold/warm artifact in a temporary directory
(three cold and five warm samples by default); it never rewrites the checked-in
baseline. The gate validates the artifact schema and corpus, compares graph
counts and expected-record accuracy, and fails if any fixture is no longer
byte-deterministic across its scans. When the candidate and baseline disclose
the same runtime and hardware environment, the gate compares median time for
every fixture and fails an unexplained regression above 20%. The artifact still
records p95 and peak RSS for review; those values are intentionally not used as
the automated gate because they are sensitive to scheduler and process-memory
state. Use `--explain "..."` for a reviewed, documented performance exception.
Hosted CI may report the performance check as skipped when its runner differs
from the recorded device baseline; a release check on the baseline device uses
`npm run benchmark:ci -- --require-compatible-environment` so that an
environment mismatch itself fails closed.

The CI workflow also runs the bounded revision-diff baseline and gate after the
scan benchmark checks; neither command rewrites a checked-in artifact.
