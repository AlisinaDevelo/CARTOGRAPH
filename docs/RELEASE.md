# Release process

CARTOGRAPH has not published an npm or GitHub release. This document is the proposed release gate; it is not evidence that a release pipeline exists.

Before the first tagged release:

1. Confirm package ownership and final package/brand naming.
2. Run format, lint, typecheck, unit/integration tests, coverage, build, and a package dry-run from a clean checkout.
3. Install the packed tarball in a temporary fixture and run `cartograph --version`, `cartograph --help`, a scan, and a diff.
4. Validate schema compatibility, deterministic fixtures, and the declared support matrix.
5. Run `npm run change-control:validate`; overdue compatibility surfaces or removals without a migration note and fixture update block the release gate.
6. Run `npm run policy-bundle:migrations:validate`; expiry, revocation, owner, selector, or compatibility migration failures must remain blocked until reviewed or repaired.
7. Run `npm run assurance-signing:validate`; old keys, missing roots, tampered manifests, revoked keys, and no-fallback failures must remain explicit.
8. Review dependencies, pinned workflows, threat-model gates, and open security findings.
9. Update `CHANGELOG.md`, version, migration notes, and checksums or provenance metadata.
10. Create a signed or otherwise provenance-backed release only after publishing credentials use trusted publishing or an equally scoped mechanism.

Generated `dist`, coverage, temporary repositories, reports, and package tarballs stay out of source commits.
