# Upgrade and maintenance policy

This document is the public upgrade guide for CARTOGRAPH. Its machine-readable
source is [`schema/upgrade-policy.v0.1.json`](../schema/upgrade-policy.v0.1.json),
validated by `npm run upgrade:validate`. The validator cross-checks this policy
against `package.json`, `package-lock.json`, the CI workflow, the support matrix,
the compatibility manifest, and the adapter contract.

## Semantic-versioning rules

- **Patch:** bug fixes, documentation, and internal changes that preserve public
  behavior and artifact meaning.
- **Minor:** additive optional fields, diagnostics, report details, and
  backwards-compatible capabilities. Existing readers retain their meaning.
- **Major:** required or removed fields, changed identity, changed meaning,
  retired readers, or any incompatible artifact contract. A migration review is
  required.
- **Before 1.0:** package semver does not override the independently versioned
  snapshot, diff, policy, or adapter contracts. Those contracts still require
  explicit compatibility review.

The package currently requires Node `>=22.13.0`. The declared LTS and CI window
is Node 22.x and 24.x on Linux and macOS, with TypeScript 6.0.3 and ts-morph
28.0.0. A newer compatible local Node is useful verification evidence but does
not expand the support claim.

## Compatibility and deprecation

Snapshot, diff, capability, diagnostic, and adapter compatibility versions are
published in the [compatibility manifest](../schema/compatibility.json) and
must match the upgrade policy. Adapter API and adapter compatibility are both
currently version 1, and the adapter negotiation contract is version 1. Readers
accept only versions listed as supported; unknown or retired versions fail
closed. The negotiation migration window and experimental opt-in rules are
documented in the [adapter contract](ADAPTERS.md).

Deprecation requires a changelog and compatibility-policy notice naming affected
readers and the replacement. A deprecated field or value remains readable for
one documented compatibility window. Removal requires a reviewed breaking
release or an explicit migration record with representative fixtures; the
upgrade note must explain the deterministic reader/writer behavior.

## Upgrade procedure

1. Read the release notes, this policy, and the compatibility manifest.
2. Install the declared Node LTS runtime and run `npm ci --ignore-scripts`.
3. Run `npm run upgrade:validate` and `npm run check` locally.
4. For a schema or adapter change, inspect the migration fixtures and the
   compatibility review before accepting the new reader/writer boundary.
5. Re-run the package and installed-CLI smoke tests against the merged commit.

The maintainer is [`@AlisinaDevelo`](https://github.com/AlisinaDevelo). Review
this policy at least quarterly and before every minor release. Public support
uses GitHub issues; security reports use private vulnerability reporting.
