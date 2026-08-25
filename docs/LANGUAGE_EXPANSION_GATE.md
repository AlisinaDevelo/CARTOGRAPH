# Language-expansion gate

E-012 turns the bounded Rust pilot into a public, digest-bound decision rather
than an open-ended language-support promise. The machine-readable report is
[`report.v0.1.json`](../test/fixtures/language-expansion-gate/report.v0.1.json)
and its schema is
[`language-expansion-gate.v0.1.schema.json`](../schema/language-expansion-gate.v0.1.schema.json).
Run `npm run language-expansion:validate` to replay the local gate.

## Result

The 2026-08-25 gate retains `cartograph.rust` as a bounded implemented pilot and
keeps broad `language.rust` expansion deferred. Conformance, semantic coverage,
unknown rate, precision, recall, performance, maintenance cost, security
ownership, and evidence completeness are compared against predeclared
thresholds. The only missed graduation criterion is independent demand: no
such signal is recorded in the repository evidence set.

The public decision is [ADR 0006](adr/0006-language-expansion-gate.md). It
creates no implementation commitments. The pilot remains limited to Rust
module/function declarations, local imports and calls, literal HTTP origins,
and literal SQL table relationships. Traits, macros, generics, ownership,
compiler resolution, runtime behavior, and dynamic destinations remain outside
the claim.

## Evidence boundary

The report reuses the E-005 adapter-conformance and quality measurements, the
E-010 cross-language equivalence corpus, and the E-011 lifecycle/security
policy. It records commands and repository paths rather than copying source
bodies, external data, secrets, or telemetry. The decision is a local release
gate, not a market-demand survey or a claim of universal Rust support.
