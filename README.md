# CARTOGRAPH

Evidence-backed architecture change control for TypeScript codebases.

[![CI](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/ci.yml/badge.svg)](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/ci.yml)
[![CodeQL](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/codeql.yml/badge.svg)](https://github.com/AlisinaDevelo/CARTOGRAPH/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

CARTOGRAPH scans a supported repository into a deterministic architecture graph, compares two Git revisions, and shows which nodes and relationships changed. Every emitted relationship carries repository-relative source evidence or an explicit unresolved reason.

The project is pre-alpha. The local TypeScript/Express slice works and is tested; policy enforcement, a reusable GitHub Action, stable identity across refactors, bounded adapters, optional local runtime evidence, and local export/import are roadmap work. Any hosted or account-based scope remains behind later traction, privacy, security, capacity, and funding decisions.

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
  --format html \
  --output .cartograph/architecture-diff.html
```

New output files are created with private permissions and are not overwritten unless you pass `--force`. Before opening an output path, CARTOGRAPH rejects a final symlink and any existing user-controlled symlinked parent component (apart from macOS's standard `/tmp` and `/var` root aliases); the final component is opened with no-follow semantics. These are preflight checks, not a race-free guarantee against concurrent filesystem changes. Omit `--output` to write to stdout.

## What the first analyzer understands

| Construct                                                                              | Current behavior                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| TypeScript `.ts`, `.tsx`, `.mts`, and `.cts` files                                     | Scanned; declaration files and generated/dependency directories are excluded |
| Local and external imports, re-exports, literal dynamic imports, and literal `require` | Module edges with source evidence                                            |
| Named functions, class methods, and variable-bound arrow functions                     | Function nodes; semantically resolvable calls become edges                   |
| Direct Express `app`/`router` routes with literal paths                                | Endpoint and handler relationships                                           |
| Literal `fetch` and Axios destinations                                                 | Outbound request relationships                                               |
| Conventional Prisma model operations                                                   | Read/write relationships to data nodes                                       |
| Dynamic routes, imports, HTTP destinations, models, or unresolved handlers/calls       | Stable diagnostics; no confident guessed edge                                |

JavaScript files, generated routes, framework metaprogramming, and complete runtime behavior are not supported. A plausible-looking result outside the table is not a support claim.

## Commands

```text
cartograph scan [root]
cartograph diff [root] --base <ref> [--head <ref>]
cartograph diff-snapshots <before.json> <after.json>
cartograph migrate-snapshot <input.json> --report <report.json>
```

`scan` emits canonical graph JSON. `diff` and `diff-snapshots` support `json`, `markdown`, and self-contained `html` reports. Use `--tsconfig <path>` to select a configuration inside the analyzed repository. Use `--config <path>` to apply the versioned, repository-relative [configuration contract](docs/CONFIGURATION.md); command-line flags override matching invocation settings.

`migrate-snapshot` rewrites the historical GraphSnapshot v0 fixture to v1 and
records every changed node or edge identity. Migration output is deterministic
and requires the documented manual review gate in
[the migration matrix](docs/IDENTITY_MIGRATION.md).

The Git revision flow validates refs, archives each commit into an isolated temporary directory, rejects archived symbolic links, analyzes without executing repository code, and cleans the temporary tree. It never checks out, resets, cleans, or stashes the caller's worktree.

## Evidence contract

JSON is the canonical interchange format. A source evidence record includes:

- a repository-relative path and source position;
- a versioned detector identity;
- a SHA-256 content hash;
- no source body or absolute path.

Each edge also records explicit confidence and must carry evidence or an
actionable unresolved reason. Unknown evidence fields are rejected by the
runtime contract.

The surrounding snapshot records the exact analyzed commit for revision-backed scans. Graphs and diffs are runtime-validated, referentially checked, deduplicated, and canonically sorted. Identical input produces byte-identical normalized JSON.

The canonical [GraphSnapshot v0.1 JSON Schema](schema/graph-snapshot.v0.1.schema.json)
defines the portable interchange shape. The runtime validator additionally checks
cross-record node references, duplicate identities, and canonical normalization.
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
- [CLI runtime and exit policy](docs/CLI.md)
- [Support matrix and review process](docs/SUPPORT_MATRIX.md)
- [Maintenance and ownership](docs/MAINTENANCE.md)
- [Compatibility and versioning](docs/COMPATIBILITY.md)
- [Snapshot and identity migration](docs/IDENTITY_MIGRATION.md)
- [Configuration contract](docs/CONFIGURATION.md)
- [Fixture provenance](docs/FIXTURES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Evaluation strategy](docs/EVALUATION.md)
- [Benchmark corpus and measurement protocol](docs/BENCHMARK_PROTOCOL.md)
- [Digest-bound policy bundles](docs/POLICY_BUNDLES.md)
- [Deprecation and change-control register](docs/CHANGE_CONTROL.md)
- [Landscape research](docs/RESEARCH.md)
- [Five-year roadmap](docs/ROADMAP.md)
- [Design-partner outreach](docs/OUTREACH.md)
- [Release gate](docs/RELEASE.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
