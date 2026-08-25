# Language-neutral graph semantics

CARTOGRAPH's canonical graph is an interchange contract, not a TypeScript
abstract syntax tree. An adapter may understand a language or framework, but it
must translate that understanding into the same portable graph semantics. A
consumer can therefore review a snapshot without installing the adapter that
produced it.

## Intermediate representation

`GraphSnapshot` is the language-neutral intermediate representation (IR). It
contains:

- nodes with a stable identity, a semantic `kind`, a display `name`, optional
  opaque `language` metadata, and an optional repository-relative source
  location;
- edges between declared node IDs with a semantic edge `kind`, confidence, and
  evidence or an explicit unresolved reason; and
- diagnostics that preserve unsupported or ambiguous analysis as structured,
  evidence-linked records.

The node and edge kind vocabularies describe architecture (`service`,
`function`, `database_table`, `calls`, `reads`, `requests`, and so on). They do
not describe a particular parser. New adapters map their native constructs into
these kinds and keep native detail in evidence, names, or adapter-specific
capability metadata rather than changing the meaning of the core graph.

`language` is an optional identifier such as `rust`, `python`, or `typescript`.
It is metadata, not a discriminator for the core schema. Adding a language value
is additive; it does not require a GraphSnapshot version bump. An adapter that
cannot classify a node may omit the field or use the `unknown` node kind, but it
must not invent a language-specific semantic kind.

## Identity

Adapters produce `id` and `stableKey` values. `stableKey` is the portable
identity supplied by the adapter; it is not required to encode a TypeScript
symbol. The identity reconciler first preserves equal stable keys, then uses
conservative signals that are available to any adapter: semantic kind, optional
language, name, declared path history, and graph neighborhood. `language` is a
signal, never a TypeScript-only gate.

Only unique, sufficiently supported candidates become matches. Equal-score or
non-mutual candidates remain explicit ambiguity records, and weak rename
candidates remain unsupported records. A new language adapter must preserve
this fail-closed behavior rather than guessing continuity from a familiar name
or path alone.

## Source mapping and evidence

Source coordinates are repository-relative and portable:

- paths use normalized `/` separators and cannot be absolute, URI-based, or
  escape the repository;
- lines and columns are one-based positive integers; and
- locations may include an end line and end column when the adapter can provide
  them.

Source evidence repeats or references the same coordinate and must include a
versioned detector identity and a SHA-256 content hash. The hash binds the
evidence to the analyzed source without copying source bodies. Runtime, Git,
and user evidence may be used when source evidence is not the appropriate
authority, but it must remain explicit and portable.

Every emitted edge has at least one evidence record or an actionable
`unresolvedReason`. This rule applies equally to Rust, Python, TypeScript, and
future adapters; an adapter must never turn an unresolved relationship into a
confident edge merely because its framework is familiar.

## Unknown and unsupported semantics

Unknown behavior is part of the result. A registered diagnostic records the
stable code, severity, message, remediation, source location, and evidence for
an unsupported or ambiguous construct. An edge that is known to exist but whose
supporting evidence is incomplete may instead carry an explicit unresolved
reason and an empty evidence list. Consumers can distinguish:

1. an evidence-backed relationship;
2. an inferred relationship with bounded evidence; and
3. a relationship or construct that remains unresolved or unsupported.

No adapter may silently drop a construct, emit an unregistered diagnostic, or
guess a relationship without one of those visible outcomes. Capability and
diagnostic registries remain versioned independently from the GraphSnapshot
shape.

## Compatibility promise

The published GraphSnapshot v1 schema, runtime validator, identity rules, and
evidence requirements are the language-neutral boundary. The compatibility
fixture at
[`test/fixtures/language-neutral/compatibility.v0.1.json`](../test/fixtures/language-neutral/compatibility.v0.1.json)
keeps Rust and Python metadata, coordinates, evidence, unresolved edges, and
diagnostics under that same boundary. Existing TypeScript/Express and Fastify
adapters are checked alongside the fixture so adding language-neutral coverage
does not weaken their contract.

The contract is reviewed as `languageNeutralSemantics` in
[`schema/compatibility.json`](../schema/compatibility.json). This review adds
documentation and compatibility evidence only; it does not change the
GraphSnapshot, GraphDiff, capability, or diagnostic registry versions.
