# Changelog

This file records user-visible changes. The project is currently unreleased; no npm
package has been published. A `v<package-version>` tag runs the read-only package
gate and creates a GitHub release with the installable tarball, release notes, and
checksums.

## [Unreleased]

### Added

- `cartograph controls evaluate`: trace named control objectives to policies,
  findings, decisions, waivers, tests, owner assertions, and bundle artifacts,
  separating observed evidence from owner assertions and listing gaps and
  conflicts, with fixed non-certification limitations
  ([guide](docs/CONTROL_EVIDENCE.md)).
- History trends mark gaps, retention removals, partial snapshots, contract,
  extractor, policy, decisions, workspace-scope, migration, and sampling
  changes; withhold deltas for incomparable metrics; report uncertainty
  bands, restatements against an earlier report, and reviewer explanations.
- `cartograph sbom link`: relate CycloneDX or SPDX components and SLSA build
  subjects to graph objects, with link method, confidence, unresolved
  reasons, version skew, and measured coverage only
  ([guide](docs/SBOM_LINK.md)).
- `cartograph history gc`: retention by kind and classification with holds,
  reference-safe removal, verified compaction of reproducible diffs,
  tombstones, and checked deletion; `history export --kind --profile` for
  scoped, redacted export.
- Local export and import boundary review ([M-018](docs/LOCAL_HANDOFF_REVIEW.md)).
  `history import` now re-reads existing objects before deduplicating,
  refuses a symbolic-linked store, and reports conflicting snapshots of one
  revision.
- `cartograph bundle check` and `bundle share`: fail-closed safe-sharing
  checks for `team` and `public` recipients that never print the flagged
  values, field-level redaction, keyed path and host pseudonymization, and a
  [threat model](docs/SHARING.md). `bundle create --profile` refuses unsafe
  inputs.
- `cartograph history trends`: reproducible architecture trend metrics
  (boundaries, cycles, unknowns, policy findings, decision coverage, churn)
  recomputed from stored history, each with its numerator, denominator, and
  scope.
- `cartograph history`: a local, content-addressed store of snapshots, diffs,
  policies, decisions, finding lifecycles, workspace compositions, and
  provenance, with `import`, `list`, `verify`, `repair`, and `export`.
- `cartograph bundle create` and `bundle verify`: reproducible, offline-verifiable
  assurance bundles of snapshots, diffs, policies, evaluations, decisions,
  waivers, query results, configuration, and reports.
- Bundles record the analyzer build fingerprint and can be signed with your own
  Ed25519 key (`bundle payload`) and verified offline against a keyring and
  trust roots (`bundle verify --signature`).
- `diff --cache-dir` reuses revision snapshots keyed by the analyzer build,
  contracts, configuration, and the commit and tree being analyzed.
- Query predicates for evidence source spans (`evidence.line`), extractor
  versions (`evidence.detector`), and unresolved edges (`unresolved`,
  `unresolved.reason`), plus a query regression and authorization-boundary
  corpus.
- Functions bound to class fields and to `as`/`satisfies`-wrapped initializers
  are analyzed as callables.

### Fixed

- Query path checks reject `..` segments written with backslashes.

## [0.1.1] - 2026-09-28

The first published release. `v0.1.0` was tagged, but its release workflow
stopped at the package smoke test and published nothing; 0.1.1 contains
everything listed under 0.1.0 plus the fix below.

### Fixed

- The release smoke test installs the packed tarball with `npm ci --offline`
  from a lockfile derived from `package-lock.json`. The previous
  `npm install --offline <tarball>` needed registry metadata that is never
  cached, so it could not pass on a clean runner. CI now runs this check on
  every pull request.
- The release guide no longer tells consumers to install the tarball with
  `--offline`.

### Changed

- Development dependencies: Vitest and `@vitest/coverage-v8` 5.0, plus minor
  and patch updates to the lint, format, and type tooling.

## [0.1.0] - 2026-09-28

First tagged release. The attested tarball is attached to the GitHub release.

### Added

- Initial public repository baseline for the local TypeScript architecture-analysis workflow.
- Versioned graph/evidence schemas, deterministic canonicalization, and semantic architecture diffs.
- TypeScript/Express extraction for supported imports, calls, routes, HTTP requests, and Prisma operations with explicit diagnostics.
- Non-destructive Git revision comparison and JSON, Markdown, and self-contained HTML reports.
- A validated five-year roadmap with 20 dated milestones, 179 outcome-bearing issues, 514 prerequisite relationships, and an idempotent GitHub reconciliation tool.
- Community, security, and contribution policies for the project’s early development phase.
- JavaScript sources (`.js`, `.jsx`, `.mjs`, `.cjs`) are analyzed when a
  `tsconfig.json` sets `allowJs`, under a `jsconfig.json`, or in a repository
  with no TypeScript at all; their nodes carry `language: "javascript"`.
- `cartograph export` for graph-interchange JSON, JSON-LD, edge-list, and SCIP
  output, and `policy --format sarif` for GitHub code scanning.
- `cartograph init` scaffolds a config, an informational starter policy, and
  the pull-request workflow.
- `cartograph query` for module import cycles, dependency paths, graph query
  language expressions, and architecture-query requests, with
  `--fail-on-match` for CI gates.
- Policy path patterns (`path`, `fromPath`, `toPath`, their `…Exclude`
  variants, and `toPackage`) for layering rules, and an `acyclic` assertion
  for edge rules.
- Optional npm publication of the attested release tarball through npm
  trusted publishing.

### Fixed

- A `tsconfig.json` that extends a package (such as `@tsconfig/node20`) no
  longer aborts the scan. The base is read from an in-repository
  `node_modules` when installed; otherwise the scan continues with the local
  options and reports `UNRESOLVED_TSCONFIG_EXTENDS`.
- Scans of repositories with around 2,000 files no longer hit the default
  report-item ceiling, and ceiling errors name the config key to raise.
- Node and edge policy rules now match the added, changed, and rewired records
  of a `GraphDiff`; previously they never matched diff input.
- Calls whose callee comes from an npm package, or through a parameter, no
  longer produce `UNRESOLVED_CALL`, removing about 90% of diagnostics on real
  repositories.
- Calls to members declared only by an interface or object type
  (`schema.parse()`) are treated as dynamic dispatch rather than reported as
  `UNRESOLVED_CALL`.
- `maxMemoryBytes` is measured from the resident memory when an analysis
  starts, so hosts that embed the analyzer are not charged for memory they
  were already using.
- Faster, lighter analysis: cached line lookups, module-resolution probes, and
  call resolution, and callable discovery that no longer wraps every syntax
  node (about 4x faster and 12% less memory on a 1,900-file repository).

### Notes

- Contract versions and the upgrade policy this release ships with are listed
  in `docs/COMPATIBILITY.md` and `docs/UPGRADING.md`. Before 1.0, package
  semver does not override the independently versioned snapshot, diff,
  policy, and adapter contracts; each contract change still requires an
  explicit compatibility review.
