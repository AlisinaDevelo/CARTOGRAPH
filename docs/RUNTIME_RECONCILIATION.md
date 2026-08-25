# Local static/runtime reconciliation

O-002 publishes a deterministic, local reconciliation contract for comparing a
normalized O-001 runtime trace with one canonical static graph snapshot. It is
an evidence index, not a claim that runtime behavior is a complete architectural
model.

## Inputs and boundary

`reconcileRuntimeTrace` accepts three explicit inputs:

- a versioned `GraphSnapshot`;
- a normalized `cartograph.runtime-traces` artifact; and
- a bounded binding list that maps a trace/span identity to a static node with
  either `certain` or `inferred` confidence.

The binding list is deliberately explicit. CARTOGRAPH does not guess a node
from a span name, service name, source path, or arbitrary trace attribute.
Unknown spans, unknown nodes, and duplicate bindings fail closed. The
implementation is a pure in-process function: it does not collect, upload,
retain, redact, or execute trace data, and it does not load modules or contact a
network.

## Classifications

Each runtime parent/child span pair with two bindings becomes an observed
endpoint pair. The reconciler emits:

- `observed-and-modeled` when the endpoints identify exactly one static edge;
- `ambiguous` when the endpoints identify multiple static edges;
- `observed-but-unmodeled` when the endpoints have no static edge, or a span or
  parent is not explicitly bound; and
- `modeled-not-observed` for every static edge not covered by a mapped runtime
  pair.

Records are sorted by stable IDs and include static edge IDs, static evidence
references, trace references, an evidence-reference union, an observation
count, a conservative uncertainty value, and a human-readable reason. An
ambiguous or unmapped result never upgrades runtime evidence into architectural
certainty. Static edges participating in an ambiguous endpoint are considered
observed but remain ambiguous.

The published output schema and fixture are
[`schema/runtime-reconciliation.v0.1.schema.json`](../schema/runtime-reconciliation.v0.1.schema.json),
[`schema/runtime-reconciliation.v0.1.json`](../schema/runtime-reconciliation.v0.1.json),
and
[`schema/runtime-reconciliation-fixture.v0.1.json`](../schema/runtime-reconciliation-fixture.v0.1.json).
Validate them offline with:

```sh
npm run runtime-reconciliation:validate
```

The O-003 redaction/retention policy is documented in
[`RUNTIME_TRACE_SAFETY.md`](RUNTIME_TRACE_SAFETY.md). A CLI/report surface,
automatic span binding, and hosted collection remain separate follow-on
decisions.

## O-004 synthetic evaluation

The local evaluation command runs a small, explicit oracle against the
reconciliation function:

```sh
npm run runtime-reconciliation:evaluation:validate
```

The fixture is
[`test/fixtures/runtime-reconciliation-evaluation/scenarios.v0.1.json`](../test/fixtures/runtime-reconciliation-evaluation/scenarios.v0.1.json).
It contains a complete five-span trace and a sampled variant that removes the
tail span. Both cases retain the same hand-authored expected classifications,
so the sampled case makes the effect of missing observations visible instead
of silently changing the oracle. The published report is
[`schema/runtime-reconciliation-evaluation.v0.1.json`](../schema/runtime-reconciliation-evaluation.v0.1.json).

Metrics are calculated over exact `(record ID, classification)` pairs:

- precision is true positives divided by emitted records;
- recall is true positives divided by expected records;
- coverage is retained runtime parent/child edges divided by expected runtime
  edges, capped at `1`; and
- ambiguity rate is ambiguous emitted records divided by emitted records.

The current synthetic baseline reports precision `0.875`, recall `0.875`,
runtime-edge coverage `0.8333333333333334`, and ambiguity rate `0.25`.
This is a regression baseline, not a population estimate. It does not measure
binding discovery, production trace representativeness, collector behavior,
or the prevalence of unobserved edges. Sampling can turn a previously observed
edge into `modeled-not-observed` or create an `observed-but-unmodeled` record;
the coverage metric makes that loss explicit.

Release gating is deliberately disabled in the fixture and report until a
maintainer reviews the baseline and chooses thresholds. The evaluation is
offline and does not upload traces, contact a collector, or enable hosted CI
behavior.
