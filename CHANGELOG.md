# Changelog

This file records user-visible changes. The project is currently unreleased; no npm
package has been published. A `v<package-version>` tag runs the read-only package
gate and creates a GitHub release with the installable tarball, release notes, and
checksums.

## [Unreleased]

### Added

- `cartograph query` for module import cycles, dependency paths, graph query
  language expressions, and architecture-query requests, with
  `--fail-on-match` for CI gates.
- Policy path patterns (`path`, `fromPath`, `toPath`, their `…Exclude`
  variants, and `toPackage`) for layering rules, and an `acyclic` assertion
  for edge rules.
- Optional npm publication of the attested release tarball through npm
  trusted publishing.

### Fixed

- Node and edge policy rules now match the added, changed, and rewired records
  of a `GraphDiff`; previously they never matched diff input.
- Calls whose callee comes from an npm package, or through a parameter, no
  longer produce `UNRESOLVED_CALL`, removing about 90% of diagnostics on real
  repositories.
- Faster analysis from cached line lookups and call resolution.

## [0.1.0]

### Added

- Initial public repository baseline for the local TypeScript architecture-analysis workflow.
- Versioned graph/evidence schemas, deterministic canonicalization, and semantic architecture diffs.
- TypeScript/Express extraction for supported imports, calls, routes, HTTP requests, and Prisma operations with explicit diagnostics.
- Non-destructive Git revision comparison and JSON, Markdown, and self-contained HTML reports.
- A validated five-year roadmap with 20 dated milestones, 179 outcome-bearing issues, 514 prerequisite relationships, and an idempotent GitHub reconciliation tool.
- Community, security, and contribution policies for the project’s early development phase.

### Notes

- Compatibility guarantees, stable APIs, and release support policies will be defined before the first versioned release.
