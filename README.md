# CARTOGRAPH

Deterministic architecture graph, revision-diff, policy, and bounded runtime-reconciliation tooling for TypeScript.

[![CI](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/ci.yml/badge.svg)](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/ci.yml)
[![CodeQL](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/codeql.yml/badge.svg)](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

CARTOGRAPH scans a supported repository into a deterministic architecture graph, compares two Git revisions, and shows which nodes and relationships changed. Every emitted relationship carries repository-relative source evidence or an explicit unresolved reason.

## Boundary with STRATA

STRATA is the compiler-backed semantic architecture-change analyzer/package for
TypeScript revisions. CARTOGRAPH is the broader architecture graph, report,
policy, and bounded runtime-reconciliation product: it consumes explicit
static/runtime evidence and emits reviewable graph artifacts, but does not
replace STRATA's compiler-backed semantic analysis.

The project is pre-alpha. The local TypeScript/Express slice, bounded Fastify
adapter, and a read-only, informational-by-default GitHub Action work and are
tested; stable identity across refactors, broader framework coverage, runtime
redaction/retention, and hosted export remain roadmap work. The versioned local
adapter, inert OTLP import, and explicit local reconciliation boundaries are
published, but none executes repository code or contacts a network. Any
hosted or account-based scope remains behind later traction, privacy, security,
capacity, and funding decisions.

## Quickstart

CARTOGRAPH is not published to npm yet. Run the current source build with Node.js 22.13 or newer:

```sh
git clone https://github.com/AlisinaDevelo/CARTOGRAPH.git
cd CARTOGRAPH
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
node dist/cli.js --version
npm pack --dry-run --ignore-scripts
```

The [full quickstart and limitations guide](docs/QUICKSTART.md) uses the
[sample repository](examples/sample-repository/) to demonstrate a first scan,
revision diff, configuration, privacy boundary, unsupported constructs,
troubleshooting, and the read-only Action.

The [safe policy and ADR workflow](docs/WORKFLOW.md) connects scan, diff,
decision references, policy observation, migration, and human remediation
review. Its isolated fixture runs the documented path locally and in CI.

Tagged releases are produced by the read-only package gate in
[`docs/RELEASE.md`](docs/RELEASE.md). Each GitHub release includes an installable
tarball, release notes, a SHA-256 checksum, and package-install smoke-test metadata.

Scan a working tree into canonical JSON:

```sh
mkdir -p .cartograph
node dist/cli.js scan /path/to/typescript-project \
  --output .cartograph/current.graph.json
```

Compare two local Git revisions without checking either one out:

```sh
node dist/cli.js diff /path/to/repository \
  --base origin/main \
  --head HEAD \
  --comparison merge-base \
  --format html \
  --output .cartograph/architecture-diff.html
```

Run the read-only [GitHub Action](docs/ACTION.md) on a pull request with a
full-history checkout. It uses the event's exact base and head SHAs, emits an
informational job summary, and uploads a self-contained HTML/JSON artifact:

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
    with:
      persist-credentials: false
      fetch-depth: 0
      ref: ${{ github.event.pull_request.head.sha }}
  - uses: AlisinaDevelo/CARTOGRAPH@629ee26cc179f08848b09f8c5caeaaf48f6e134c # D-013
    with:
      comparison: merge-base
```

New output files are created with private permissions and are not overwritten unless you pass `--force`. Before opening an output path, CARTOGRAPH rejects a final symlink and any existing user-controlled symlinked parent component (apart from macOS's standard `/tmp` and `/var` root aliases); the final component is opened with no-follow semantics. These are preflight checks, not a race-free guarantee against concurrent filesystem changes. Omit `--output` to write to stdout.

## What the first analyzer understands

| Construct                                                                                                                                                              | Current behavior                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript `.ts`, `.tsx`, `.mts`, and `.cts` files                                                                                                                     | Scanned; declaration files and bounded build/dependency directories are excluded, with generated provenance retained                    |
| Local and external imports, re-exports, literal dynamic imports, and literal `require`                                                                                 | Module edges with source evidence                                                                                                       |
| Named functions, class methods, and variable-bound arrow functions                                                                                                     | Function nodes; semantically resolvable calls become edges                                                                              |
| Direct Express `app`/`router` routes and bounded `use` middleware with literal paths                                                                                   | Endpoint and handler relationships                                                                                                      |
| GraphQL SDL root fields and OpenAPI path operations with local resolver/handler links                                                                                  | Evidence-backed endpoint boundaries and `routes_to` relationships                                                                       |
| Prisma datasources, models, relations, and bounded generated-client references                                                                                         | Typed database, service, and module nodes with schema evidence                                                                          |
| npm, pnpm, Yarn, and Bun lockfile dependency records                                                                                                                   | Deterministic offline `depends_on` edges with lockfile evidence                                                                         |
| Generated directories, filename markers, configured exclusions, and `generated-from` markers                                                                           | Generated modules are classified; excluded generated paths receive exact-path diagnostics and selected sources receive provenance edges |
| Literal EventEmitter events, bounded Bull/BullMQ queues, timers, and local callbacks                                                                                   | Queue publication/registration and handler relationships with source evidence                                                           |
| Literal `fetch` and Axios destinations                                                                                                                                 | Outbound request relationships                                                                                                          |
| Conventional Prisma model operations                                                                                                                                   | Read/write relationships to data nodes                                                                                                  |
| Dynamic routes, API schema generation/aliases, imports, HTTP destinations, event/queue names, reflective handlers, unresolved calls, or ambiguous/mismatched lockfiles | Stable diagnostics with source evidence and remediation; no guessed edge                                                                |

JavaScript files, generated routes, framework metaprogramming, and complete runtime behavior are not supported. Generated TypeScript is not silently treated as ordinary source: selected artifacts are marked `typescript-generated`, and excluded generated files remain visible through `EXCLUDED_GENERATED_FILE` diagnostics. A plausible-looking result outside the table is not a support claim.

## Commands

```text
cartograph scan [root]
cartograph diff [root] --base <ref> [--head <ref>] [--comparison direct|merge-base] [--adr <path>]
cartograph diff-snapshots <before.json> <after.json>
cartograph migrate-snapshot <input.json> --report <report.json>
```

`scan` emits canonical graph JSON. `diff` and `diff-snapshots` support `json`, `markdown`, and self-contained `html` reports. Add `--adr <path>` to `diff` to compare a repository-local ADR reference index at both revisions; Markdown and HTML reports then include deterministic ADR title/status, graph evidence, added/removed/changed references, stale-link diagnostics, and bidirectional ADR coverage indexes with counts by node and edge kind. Use `--tsconfig <path>` to select a configuration inside the analyzed repository. Use `--config <path>` to apply the versioned, repository-relative [configuration contract](docs/CONFIGURATION.md); command-line flags override matching invocation settings.

`migrate-snapshot` rewrites the historical GraphSnapshot v0 fixture to v1 and
records every changed node or edge identity. Migration output is deterministic
and requires the documented manual review gate in
[the migration matrix](docs/IDENTITY_MIGRATION.md).

The Git revision flow validates refs, archives each commit into an isolated temporary directory, rejects archived symbolic links, analyzes without executing repository code, and cleans the temporary tree. It never checks out, resets, cleans, fetches, or stashes the caller's worktree. `direct` compares the resolved base tree to the resolved head tree. `merge-base` implements pull-request semantics by comparing the resolved merge base to the head; it fails closed for shallow repositories, unrelated histories, or multiple merge bases instead of fetching or guessing. Direct mode remains available for explicitly comparing unrelated trees.

## Evidence contract

JSON is the canonical interchange format. A source evidence record includes:

- a repository-relative path and source position;
- a versioned detector identity;
- a SHA-256 content hash;
- no source body or absolute path.

Each edge also records explicit confidence and must carry evidence or an
actionable unresolved reason. Unknown evidence fields are rejected by the
runtime contract.

The surrounding snapshot records the exact analyzed commit for revision-backed scans. Revision diffs also record the requested refs, resolved base/head commits, comparison mode, and merge base when applicable. Graphs and diffs are runtime-validated, referentially checked, deduplicated, and canonically sorted. Identical input produces byte-identical normalized JSON.

The canonical [GraphSnapshot v0.1 JSON Schema](schema/graph-snapshot.v0.1.schema.json)
defines the portable interchange shape. The runtime validator additionally checks
cross-record node references, duplicate identities, and canonical normalization.
Identifiers and repository paths use `/` separators, date-time metadata is emitted
as UTC ISO 8601, and invalid snapshots fail with structured field paths through
`GraphValidationError`.
Schema compatibility and migration rules are documented in
[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) and checked by
`npm run schema:compatibility`.
Every analyzer snapshot and diff carries the version of the published capability
and unknown-semantics registry; unsupported registry versions fail closed.

## Privacy and security

Local analysis performs no network request, hidden telemetry, build, package lifecycle script, or module import. Static HTML reports contain no remote asset or script. Repository input is untrusted; review the [threat model](docs/THREAT_MODEL.md) before processing sensitive code and report vulnerabilities through [SECURITY.md](SECURITY.md).

The analyzer enforces configurable file-count, byte, archive, memory, wall-clock,
and report-cardinality ceilings. Library callers can pass an `AbortSignal` to
cancel an analysis; revision materialization always removes its temporary tree,
and no partial snapshot or report is returned as a successful result.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm pack --dry-run --ignore-scripts
```

The fixture corpus under `test/fixtures/` defines supported relationships and negative cases. Extraction quality is evaluated with expected edge sets and diagnostics rather than graph appearance.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a broad change. Material graph, evidence, privacy, adapter, or language changes require a public RFC issue under [GOVERNANCE.md](GOVERNANCE.md).

## Project documents

- [Product charter](docs/PRODUCT.md)
- [Quickstart and limitations](docs/QUICKSTART.md)
- [Safe policy and ADR workflow](docs/WORKFLOW.md)
- [CLI runtime and exit policy](docs/CLI.md)
- [Read-only GitHub Action](docs/ACTION.md)
- [Support matrix and review process](docs/SUPPORT_MATRIX.md)
- [Adapter selection RFC](docs/ADAPTER_SELECTION.md)
- [Adapter support matrix](schema/adapter-support-matrix.v0.1.json)
- [Maintenance and ownership](docs/MAINTENANCE.md)
- [Maintainer resilience and onboarding](docs/MAINTAINER_RESILIENCE.md)
- [Compatibility and versioning](docs/COMPATIBILITY.md)
- [Language-neutral graph semantics](docs/LANGUAGE_NEUTRAL_SEMANTICS.md)
- [Snapshot and identity migration](docs/IDENTITY_MIGRATION.md)
- [Configuration contract](docs/CONFIGURATION.md)
- [Local ADR references](docs/ADR_REFERENCES.md)
- [Policy ADR bindings](docs/POLICY_ADR_BINDINGS.md)
- [Local adapter contract](docs/ADAPTERS.md)
- [Adapter review playbook](docs/ADAPTER_REVIEW_PLAYBOOK.md)
- [Local runtime trace import](docs/RUNTIME_TRACES.md)
- [Runtime trace sampling and cost budgets](docs/RUNTIME_TRACE_BUDGETS.md)
- [Local static/runtime reconciliation](docs/RUNTIME_RECONCILIATION.md)
- [Explicit local runtime reconciliation CLI](docs/CLI.md#explicit-local-cli-integration)
- [Runtime trace safety policy](docs/RUNTIME_TRACE_SAFETY.md)
- [Fixture provenance](docs/FIXTURES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Evaluation strategy](docs/EVALUATION.md)
- [Benchmark corpus and measurement protocol](docs/BENCHMARK_PROTOCOL.md)
- [Digest-bound policy bundles](docs/POLICY_BUNDLES.md)
- [Policy-bundle migration and revocation](docs/POLICY_BUNDLE_MIGRATIONS.md)
- [Assurance signing metadata](docs/ASSURANCE_SIGNING.md)
- [Governed remediation suggestions](docs/REMEDIATION_SUGGESTIONS.md)
- [Deterministic remediation rules](docs/REMEDIATION_RULES.md)
- [Deprecation and change-control register](docs/CHANGE_CONTROL.md)
- [Landscape research](docs/RESEARCH.md)
- [Five-year roadmap](docs/ROADMAP.md)
- [Design-partner outreach](docs/OUTREACH.md)
- [Public community feedback and RFC process](docs/COMMUNITY_FEEDBACK.md)
- [Adopter feedback template](docs/ADOPTER_FEEDBACK_TEMPLATE.md)
- [OSS health and traction scorecard](docs/OSS_HEALTH_SCORECARD.md)
- [Repository adoption evaluation](docs/ADOPTION_EVALUATION.md)
- [Telemetry-free adoption measurement](docs/ADOPTION_MEASUREMENT.md)
- [Workspace federation evaluation](docs/WORKSPACE_FEDERATION_EVALUATION.md)
- [SCIP import and export](docs/SCIP_INTERCHANGE.md)
- [Explicit ownership resolution](docs/OWNERSHIP.md)
- [Sustainability and cost model](docs/SUSTAINABILITY_COST_MODEL.md)
- [Year 1–3 claims audit](docs/CLAIMS_AUDIT.md)
- [Strategy-branch privacy and security review](docs/STRATEGY_PRIVACY_SECURITY_REVIEW.md)
- [Local-first investment ADR](docs/adr/0007-local-first-investment-boundary.md)
- [Conditional Year 4 investment charter](docs/YEAR4_INVESTMENT_CHARTER.md)
- [Architecture query contract](docs/ARCHITECTURE_QUERIES.md)
- [Release gate](docs/RELEASE.md)
- [Release acceptance and rollback rehearsal](docs/RELEASE_REHEARSAL.md)
- [Changelog](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
