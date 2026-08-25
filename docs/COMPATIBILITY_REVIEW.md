# v0.1 compatibility review

R-005 records an aggregate-only review of five public TypeScript repositories
from shallow checkouts on 2026-08-25. The checked-in record is
[`scenarios.v0.1.json`](../test/fixtures/compatibility-review/scenarios.v0.1.json);
`npm run compatibility:validate` verifies its commits, digests, counts,
diagnostics, bounded failures, feedback, and follow-up issue IDs. No
third-party source, source excerpt, or graph snapshot is redistributed.

## Matrix

| Repository                                                        | Revision  |          Result |           Supported constructs | Unknown diagnostics | Failed construct / boundary                                                   |
| ----------------------------------------------------------------- | --------- | --------------: | -----------------------------: | ------------------: | ----------------------------------------------------------------------------- |
| [honojs/hono](https://github.com/honojs/hono)                     | `017000d` |        analyzed | 1,186 (497 imports, 689 calls) |                 392 | —                                                                             |
| [microsoft/tsyringe](https://github.com/microsoft/tsyringe)       | `e033769` |        analyzed |    225 (131 imports, 94 calls) |                  30 | —                                                                             |
| [pmndrs/zustand](https://github.com/pmndrs/zustand)               | `b57db4f` |        analyzed |     145 (81 imports, 64 calls) |               2,721 | —                                                                             |
| [colinhacks/zod](https://github.com/colinhacks/zod)               | `badf0b7` | bounded failure |                              — |                   — | `RESOURCE_LIMIT`: whole-repository analysis exceeded the 1 GiB memory ceiling |
| [changesets/changesets](https://github.com/changesets/changesets) | `2eb65ba` | bounded failure |                              — |                   — | `CONFIGURATION_ERROR`: external `@tsconfig/node22` extension is rejected      |

The three successful runs emitted only the declared module/import and call
edge families. Unknown behavior remained explicit: Hono reported unresolved
calls plus dynamic HTTP/import/route diagnostics, Tsyringe reported unresolved
calls from dependency-injection indirection, and Zustand reported a high
unresolved-call volume from higher-order store composition. These counts are
compatibility observations, not population-wide precision or recall claims.

## Feedback and follow-up

- Hono and Tsyringe motivate bounded async/callback coverage in
  [X-011](https://github.com/AlisinaDevelo/CARTOGRAPH/issues/83); Hono also
  exercises the schema-boundary work in
  [X-012](https://github.com/AlisinaDevelo/CARTOGRAPH/issues/110).
- Zustand is retained as a negative call-graph case for X-011 rather than a
  universal accuracy claim.
- Zod motivates explicit large-repository budgets in
  [M-001](https://github.com/AlisinaDevelo/CARTOGRAPH/issues/45) and bounded
  large-graph benchmarking in
  [D-016](https://github.com/AlisinaDevelo/CARTOGRAPH/issues/80).
- Changesets motivates the in-repository configuration-resolution boundary in
  [X-007](https://github.com/AlisinaDevelo/CARTOGRAPH/issues/32).

The review is reproducible from the recorded repository URL, commit, selected
tsconfig path, runtime, platform, and snapshot digest. It does not imply that
all constructs in any repository are supported.
