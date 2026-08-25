# RFC: adapter selection and support policy

Status: accepted for E-006

This RFC defines how CARTOGRAPH chooses the next framework or language adapter
without turning a plausible graph into a broad support claim. The
machine-readable decision record is
[`schema/adapter-support-matrix.v0.1.json`](../schema/adapter-support-matrix.v0.1.json);
this document defines the criteria and the lifecycle behind its statuses.
The current record is `cartograph-adapter-support-v0.1` with digest
`sha256:a27a1f5b82c1f9f52c435186d8e69698de93deaf3a81e94743284c1120fb59c1`.

## Scope and decision

CARTOGRAPH supports a bounded adapter contract, not every construct exposed by
a framework or language. The current implemented boundary is the TypeScript
core, the bounded Fastify adapter, and the E-005 Rust pilot. The sample adapter
is a deterministic reference fixture, and the starter package is a contributor
preview rather than a production support claim. The Rust pilot is not a broad
Rust language claim: it covers only the named module, function, literal HTTP,
and literal SQL constructs.

The E-010 equivalence corpus is now the executable boundary for comparing the
TypeScript core and Rust pilot. It checks semantic categories and evidence,
records intentional Rust projection differences, and does not promote the
pilot to a universal Rust-language claim. A future adapter proposal must add
equivalent positive and unknown cases to the same contract before it can make
a language-level support statement.

The support matrix is authoritative for four statuses:

| Status         | Meaning                                                                                                    | Claim permitted                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `implemented`  | A reviewed adapter is shipped, versioned, conformance-tested, and owned.                                   | Only the named bounded capabilities and fixtures.                    |
| `experimental` | A reviewable preview exists, but quality, ownership, or compatibility is not yet a stable support promise. | Explicit opt-in or contributor-preview use only.                     |
| `deferred`     | The candidate is plausible, but demand, evidence, ownership, or capacity is not sufficient for a pilot.    | No implementation or quality claim.                                  |
| `unsupported`  | The project does not provide an adapter or safe boundary for the candidate.                                | The input remains outside the support claim and must not be guessed. |

Changing a status requires a matrix update, a dated review, and evidence for
the transition. A deferred candidate does not become implemented merely because
an extractor happens to emit a plausible edge.

## Selection criteria

Every proposal is scored against all criteria before a pilot is accepted. A
proposal may be deferred when any required criterion is missing; a failed
security boundary is an unsupported decision until the boundary is redesigned.

### `demand` — demand and problem fit

The proposal names the users and the architecture questions it unlocks. It
records independent demand signals, competing tools or existing workflows, and
why the bounded adapter adds evidence rather than another generic parser.
Demand is a prioritization input, not permission to weaken quality thresholds.

### `semantic-fit` — graph and evidence mapping

The proposal maps its first construct slice to the language-neutral graph
vocabulary. It identifies nodes, edges, source spans, identity signals,
unknown diagnostics, and intentional non-equivalences before implementation.
The slice must be small enough to explain in a fixture, not a promise of
universal language coverage.

### `quality` — measurable correctness

The pilot declares positive, negative, and ambiguity fixtures. The release
target is at least 0.90 precision and 0.85 recall for explicitly supported
constructs, with 100% evidence or an explicit unresolved reason on every
emitted edge. Unsupported and dynamic cases must remain named diagnostics;
they cannot be counted as successful extraction.

### `reproducibility` — deterministic bounded execution

Repeated runs over the same fixture must produce byte-identical canonical
output. The adapter must obey finite file, byte, memory, output, and wall-clock
limits and declare the compiler/runtime versions it exercises. Fixtures must
be redistributable or represented by aggregate metadata with provenance.

### `security` — authority and isolation

The adapter manifest is fail-closed: source reads are scoped, network and child
process access are denied, repository code is not executed, and configuration
is JSON data. A third-party adapter must pass the isolated host or record the
documented refusal; a missing denial boundary blocks promotion.

### `ownership` — maintainers and response

An implemented or experimental entry names a primary maintainer group and a
backup group. The owner is responsible for dependency updates, fixture review,
compatibility decisions, and security intake. E-011 defines the detailed
[retirement and security-response policy](ADAPTER_RETIREMENT.md) and tabletop;
this RFC requires ownership before
an entry can leave `deferred`.

### `compatibility` — public contract cost

The proposal records adapter API, compatibility, capability-registry,
GraphSnapshot, Node, TypeScript, and ts-morph dimensions. A migration or
versioned rejection must be explicit. A framework-specific adapter cannot
silently change the language-neutral graph contract.

### `maintenance` — sustainable scope

The proposal estimates fixture, review, and dependency-maintenance cost. The
first pilot must have a bounded construct list and a named retirement trigger;
support is not expanded until the measured evidence justifies it.

## Selection and review process

1. Open a public proposal describing the criteria, bounded construct slice,
   security boundary, owner, backup, and expected evidence.
2. Record the candidate as `deferred` in the support matrix until the proposal
   is reviewed. This makes non-selection visible and creates no implementation
   commitment.
3. If demand, semantic fit, security, and capacity justify a pilot, implement
   only the named slice under the adapter contract. The E-005 Rust pilot adds
   conformance, unsupported cases, and exact fixture precision/recall evidence.
4. Add the cross-language equivalence corpus from E-010 before making a
   language-level claim. Equivalence is measured by semantic category, not by
   matching syntax or line counts.
5. Use the [E-012 gate report](LANGUAGE_EXPANSION_GATE.md) and its public ADR
   to graduate, retain as experimental, narrow, defer, or retire the candidate.
6. Re-review implemented and experimental entries quarterly and before a
   minor release. The review records the matrix digest, tested runtime,
   fixture/provenance changes, owner, and unresolved risks.

## Ownership and retirement triggers

An entry moves to `experimental`, `deferred`, or `unsupported` when any of the
following is true and no reviewed exception exists:

- the owner and backup are unavailable or do not acknowledge a security or
  compatibility issue;
- a supported construct misses the declared precision, recall, evidence, or
  determinism threshold;
- the adapter exceeds its resource boundary or requires newly undeclared
  authority;
- a dependency or compiler change cannot be reproduced within the declared
  compatibility window;
- fixture provenance, redistribution permission, or maintenance evidence has
  expired; or
- the adapter has no demonstrated demand at the next scheduled review.

Retirement removes the support claim only after the matrix records the
replacement or the reason for no replacement, preserves the last compatible
version and migration guidance, and updates the public ADR. Existing snapshots
remain readable under their versioned contracts; retirement never licenses a
silent reinterpretation of historical evidence.

## Current matrix interpretation

The current entries and their exact digests live in the
[adapter support matrix](../schema/adapter-support-matrix.v0.1.json). The
validator `npm run adapter:support:validate` checks the matrix schema, status
coverage, runtime manifests, repository references, documentation, and the
selection criteria before the normal local check pipe can pass.
