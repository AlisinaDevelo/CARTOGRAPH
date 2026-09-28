# Changelog

This file records user-visible changes. The project is currently unreleased; no npm
package has been published. A `v<package-version>` tag runs the read-only package
gate and creates a GitHub release with the installable tarball, release notes, and
checksums.

## [Unreleased]

No unreleased changes.

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
