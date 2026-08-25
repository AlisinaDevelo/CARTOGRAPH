# Uncertainty-aware runtime reconciliation

O-005 adds an additive report around the O-002 local reconciler. It keeps the
existing classifications and adds explicit metadata for the limits of an
observation: sampling strategy and rate, clock domain/offset/uncertainty,
service aliases, missing parent relationships, and the confidence policy used
to interpret each record.

The report is intentionally conservative. A span omitted by a sampler is an
observation gap, never evidence that the behavior is absent. A retained child
whose parent was omitted becomes an `observed-but-unmodeled` record with an
explicit missing-parent reference. Service aliases are descriptive metadata;
they never cause automatic span-to-node binding.

The versioned contracts and synthetic corpus are:

- [`schema/runtime-reconciliation-uncertainty-fixtures.v0.1.schema.json`](../schema/runtime-reconciliation-uncertainty-fixtures.v0.1.schema.json)
- [`test/fixtures/runtime-reconciliation-uncertainty/scenarios.v0.1.json`](../test/fixtures/runtime-reconciliation-uncertainty/scenarios.v0.1.json)
- [`schema/runtime-reconciliation-uncertainty.v0.1.schema.json`](../schema/runtime-reconciliation-uncertainty.v0.1.schema.json)
- [`schema/runtime-reconciliation-uncertainty.v0.1.json`](../schema/runtime-reconciliation-uncertainty.v0.1.json)

Run the evaluator offline with:

```sh
npm run runtime-reconciliation:uncertainty:validate
```

The fixture includes a complete exact-clock baseline, a head-sampled trace
with bounded service-local clock uncertainty, and a probabilistic sample with
an explicit parent gap. Classification and confidence changes carry a stable
reason code and explanation so a reviewer can distinguish limited sampling,
clock precision, missing parents, and binding confidence from a real modeled
change. The evaluator compares repeated runs and scenario-order permutations,
validates both JSON Schemas, and does not collect, upload, or execute trace
data.
