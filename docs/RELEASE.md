# Release process

CARTOGRAPH is not published to npm. A `v<package.version>` tag is the supported
release trigger: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
checks the tagged source, creates an installable tarball, runs an isolated package
consumer smoke test, and creates a GitHub release containing the tarball,
`SHA256SUMS`, and `release-metadata.json`. The workflow does not publish to npm;
that remains a separate trusted-publishing decision after package ownership and
adoption are established.

## Release gate

Before creating a release tag:

1. Confirm package ownership and final package/brand naming.
2. Run format, lint, typecheck, unit/integration tests, coverage, build, and a package dry-run from a clean checkout.
3. Install the packed tarball in a temporary fixture and run `cartograph --version`, `cartograph --help`, a scan, and a diff.
4. Validate schema compatibility, deterministic fixtures, and the declared support matrix.
5. Run `npm run change-control:validate`; overdue compatibility surfaces or removals without a migration note and fixture update block the release gate.
6. Run `npm run policy-bundle:migrations:validate`; expiry, revocation, owner, selector, or compatibility migration failures must remain blocked until reviewed or repaired.
7. Run `npm run assurance-signing:validate`; old keys, missing roots, tampered manifests, revoked keys, and no-fallback failures must remain explicit.
8. Run `npm run remediation-suggestions:validate`; default-off, stale, ambiguous, ownerless, security-sensitive, unsupported, and resource-bound cases must remain explicit.
9. Run `npm run remediation-rules:validate`; every reviewed rule must retain applicability, preconditions, non-goals, validation descriptions, and golden positive/negative fixtures.
10. Review dependencies, pinned workflows, threat-model gates, and open security findings.
11. Update `CHANGELOG.md` with the matching `[<version>]` section and migration notes.
12. Confirm the package version matches the tag exactly (`v0.1.0` for package `0.1.0`).
13. Create the tag from protected `main` and let the release workflow produce the artifacts.

The release artifact metadata binds the package name and version, source commit,
the downloaded tarball SHA-256 digest, the canonical gzip-decoded package-content
digest, changelog section, and smoke-test commands. The content digest keeps the
package payload comparable across npm versions that encode the same tar stream with
different gzip wrappers. A consumer can verify `SHA256SUMS` before installing the
tarball with lifecycle scripts disabled.

Generated `dist`, coverage, temporary repositories, reports, and package tarballs stay out of source commits.

## Rollback and recovery

Release tags are immutable in practice. If a release is defective:

1. Mark the GitHub release as withdrawn in its notes and stop directing users to it.
2. Prepare a corrective patch release (for example, `v0.1.1`) from `main`; do not retag a different commit as `v0.1.0`.
3. Re-run the full gate and consumer smoke test, then publish the corrective tag.
4. If npm publication is enabled later, deprecate a defective package version rather than overwriting it, and document the replacement version.
