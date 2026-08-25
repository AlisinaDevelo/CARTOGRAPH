# ADR 0006: Retain the bounded Rust pilot as experimental

- Status: accepted
- Date: 2026-08-25
- Decision: retain as experimental
- Gate report: `language-expansion-gate-v0.1`
- Report digest: `sha256:31c5097e8647b4752c8904f2cb30482c8790bf4a66222d5045a677115ebe49cc`

## Context

The E-005 Rust pilot and E-010 language-equivalence corpus demonstrate that a
small non-TypeScript adapter can emit the same language-neutral graph contract
without executing repository code. That evidence is intentionally bounded:
the pilot handles module/function declarations, local imports and calls,
literal HTTP origins, and literal SQL table relationships. Traits, macros,
generics, ownership semantics, compiler resolution, runtime behavior, and
dynamic destinations remain unsupported or deferred.

E-012 requires a public gate rather than an indefinite experimental claim. The
versioned report at
[`report.v0.1.json`](../../test/fixtures/language-expansion-gate/report.v0.1.json)
compares predeclared conformance, semantic coverage, unknown rate, precision,
recall, performance, maintenance cost, demand, security ownership, and
evidence-completeness thresholds. Its measurements come from repository-local
validators and do not include third-party source or telemetry.

## Decision

Retain `cartograph.rust` as an implemented, bounded pilot and retain broad
`language.rust` expansion as experimental/deferred. The pilot passes its
conformance, precision, recall, evidence, security-ownership, and local
performance floors. It has no independently recorded demand signal, so it does
not graduate to a broad Rust language claim. The selected outcome is therefore
**retain as experimental**.

The supported boundary remains the exact pilot slice named in the support
matrix. Unsupported constructs stay visible as diagnostics or deferred scope;
they are not silently interpreted as supported semantics.

## Alternatives

- **Graduate** — rejected because demand is zero in the local evidence set and
  compiler-sensitive Rust semantics remain outside the pilot.
- **Narrow** — rejected because the declared bounded slice meets its quality,
  evidence, security, and performance floors.
- **Retire** — rejected because the pilot is reproducible, accurate, owned, and
  useful as a language-neutral compatibility experiment.

## Consequences

No new Rust implementation work is committed by this ADR. The support matrix
continues to mark `language.rust` as deferred, while `cartograph.rust` remains
available only within its declared bounded capabilities. A future graduation
requires a new gate report with an independent demand signal, compiler-
sensitive evidence, refreshed maintenance/security ownership, and a reviewed
ADR. The next review date is 2027-08-25.
