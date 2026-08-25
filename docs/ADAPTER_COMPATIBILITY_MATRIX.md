# Adapter compatibility matrix

E-018 keeps the shipped adapter boundary honest across the runtime and
compiler versions that CARTOGRAPH supports. The checked-in matrix is
[`schema/adapter-compatibility-matrix.v0.1.json`](../schema/adapter-compatibility-matrix.v0.1.json);
the local validator runs the same bounded cases that CI runs and fails closed
when an adapter, capability, fixture, or compatibility dimension drifts.

The matrix is intentionally separate from the release compatibility matrix.
The release matrix describes package, operating-system, and pinned Action
combinations. This matrix describes adapter analysis behavior and negotiation
fixtures.

## Declared runtime and toolchain

| Node line | TypeScript | ts-morph | CI binding                    |
| --------- | ---------- | -------- | ----------------------------- |
| `22.x`    | `6.0.3`    | `28.0.0` | `CARTOGRAPH_MATRIX_NODE=22.x` |
| `24.x`    | `6.0.3`    | `28.0.0` | `CARTOGRAPH_MATRIX_NODE=24.x` |

CI sets `CARTOGRAPH_MATRIX_NODE` from the workflow matrix. The validator
compares that declaration with `process.version`; a mismatch is an error. A
developer on an unlisted local Node line is reported as `unlisted-local`, not
silently treated as a supported CI combination, while all adapter and schema
checks still run.

## Analysis coverage

Every shipped adapter must be declared, every manifest capability must be
linked to at least one declared fixture, and every fixture must be linked to a
capability. Each case runs twice through `runAdapterConformance`, with finite
resource limits, deterministic serialization, evidence completeness, minimum
graph expectations, and explicitly declared unsupported diagnostics.

| Adapter              | Capabilities                         | Fixtures                                                 |
| -------------------- | ------------------------------------ | -------------------------------------------------------- |
| `cartograph.sample`  | `sample.fixture`                     | `sample/empty`, `sample/supported`, `sample/unsupported` |
| `cartograph.fastify` | `fastify.routes`, `typescript.graph` | `fastify/bounded-routes`                                 |

An unsupported construct is part of the fixture contract. A missing warning or
error is a failure, and an adapter is never considered covered because a case
was skipped.

## Negotiation coverage

The validator runs every case in
[`scenarios.v0.1.json`](../test/fixtures/adapter-compatibility/scenarios.v0.1.json)
against the real runtime manifests. The required states are `compatible`,
`migratable`, `experimental`, and `rejected`; both shipped adapter IDs must
appear in the corpus. The target tuple is checked against the adapter API,
adapter compatibility, capability registry, and GraphSnapshot schema versions
before analysis begins.

The matrix also runs the repository schema-compatibility and upgrade-policy
checks. These are the commands used by the local pipe and by CI:

```text
npm run schema:compatibility
npm run upgrade:validate
npm run adapter:compatibility:validate
```

Matrix ID: `cartograph-adapter-compatibility-v0.1`

Matrix digest: `sha256:6bfffe7bacb44559512bf10dc6ddcb0698c39d27c8f246a2ea055642c88a4def`
