# Release process

The versioned acceptance and rollback record for the current package is
[`RELEASE_REHEARSAL.md`](RELEASE_REHEARSAL.md). It is a local evidence record;
the dry-run section does not alter an active release.

CARTOGRAPH is not published to npm. The supported v0.1 distribution decision,
including the explicit deferral of a standalone native executable, is recorded
in [`DISTRIBUTION_DECISION.md`](DISTRIBUTION_DECISION.md). A `v<package.version>`
tag is the supported release trigger:
[`.github/workflows/release.yml`](../.github/workflows/release.yml) checks the
tagged source, creates an installable tarball, runs an isolated offline package
consumer smoke test, and creates a GitHub release containing the tarball,
`SHA256SUMS`, a CycloneDX SBOM, a SLSA/in-toto provenance statement, and
`release-metadata.json`, plus the matrix-bound `compatibility-matrix.json`
record. The workflow obtains a Sigstore-backed GitHub
attestation for each release subject and verifies it against the release
workflow identity before creating the GitHub release. The workflow does not
publish to npm; that remains a separate trusted-publishing decision after
package ownership and adoption are established.

## Release gate

Before creating a release tag:

1. Confirm package ownership and final package/brand naming.
2. Run format, lint, typecheck, unit/integration tests, coverage, build, and a package dry-run from a clean checkout.
3. Install the packed tarball in a temporary fixture with lifecycle scripts disabled and offline dependency resolution; verify the package exports, `cartograph` bin, Node engine declaration, `cartograph --version`, `cartograph --help`, a scan, and a diff.
4. Validate schema compatibility, deterministic fixtures, and the declared support matrix.
5. Run `npm run release-compatibility:validate`; the release record must contain every declared Node/OS/contract/Action combination.
6. Run `npm run change-control:validate`; overdue compatibility surfaces or removals without a migration note and fixture update block the release gate.
7. Run `npm run policy-bundle:migrations:validate`; expiry, revocation, owner, selector, or compatibility migration failures must remain blocked until reviewed or repaired.
8. Run `npm run assurance-signing:validate`; old keys, missing roots, tampered manifests, revoked keys, and no-fallback failures must remain explicit.
9. Run `npm run architecture-waivers:validate`; unsigned, tampered, broadened, replayed, revoked, expired, and drifted waivers must remain visible and authority-free.
10. Run `npm run ownership-waiver-drift:validate`; owner loss, ambiguous reassignment, repository moves, policy/evidence drift, expiry, invalid signatures, key rotation, and partial workspaces must remain explicit and never renew a waiver.
11. Run `npm run review-summary:validate`; lifecycle, ownership, waiver, policy, ADR, drift, provenance, determinism, and read-only next-step cases must remain explicit.
12. Run `npm run review-workflow:evaluation:validate`; triage, ownership, waiver, stale-state, reviewer-task, maintainer-load, failure-recovery, and six abuse-case outcomes must remain digest-bound and explicit.
13. Run `npm run remediation-suggestions:validate`; default-off, stale, ambiguous, ownerless, security-sensitive, unsupported, and resource-bound cases must remain explicit.
14. Run `npm run remediation-rules:validate`; every reviewed rule must retain applicability, preconditions, non-goals, validation descriptions, and golden positive/negative fixtures.
15. Review dependencies, pinned workflows, threat-model gates, and open security findings.
16. Update `CHANGELOG.md` with the matching `[<version>]` section and migration notes.
17. Confirm the package version matches the tag exactly (`v0.1.0` for package `0.1.0`).
18. Create the tag from protected `main` and let the release workflow produce the artifacts.

The release artifact metadata binds the package name and version, source commit,
the downloaded tarball SHA-256 digest, the canonical gzip-decoded package-content
digest, the lockfile digest and dependency count, SBOM/provenance digests,
compatibility-matrix digest, changelog section, and smoke-test commands. The content digest keeps the package
payload comparable across npm versions that encode the same tar stream with
different gzip wrappers. The generated SBOM is normalized to remove build-time
timestamps and tool-version noise; its lockfile digest binds the dependency
inventory to the tagged source. The provenance statement binds the tarball
digest to the source commit, tag, lockfile, build type, and builder metadata.

Before installing, a consumer can verify every release asset's checksum and
inspect the provenance statement:

```sh
shasum -a 256 -c SHA256SUMS
node -e 'const p=require("./cartograph-cli-0.1.0.tgz.provenance.json"); if (p.subject[0].digest.sha256.length !== 64 || p.predicateType !== "https://slsa.dev/provenance/v1") process.exit(1)'
```

GitHub's signed attestation can be verified independently with the GitHub CLI:

```sh
gh attestation verify cartograph-cli-0.1.0.tgz \
  --repo AlisinaDevelo/CARTOGRAPH \
  --signer-workflow AlisinaDevelo/CARTOGRAPH/.github/workflows/release.yml
```

The package contents are fail-closed against workflow, fixture, test, script,
benchmark, and coverage paths; credentials and repository source fixtures are
not release subjects. Install the tarball with `--offline --ignore-scripts`
until the package and its provenance have been reviewed.

Generated `dist`, coverage, temporary repositories, reports, and package tarballs stay out of source commits.

## Rollback and recovery

The full owner, timing, communication, and follow-up rehearsal is recorded in
[`RELEASE_REHEARSAL.md`](RELEASE_REHEARSAL.md). Release tags are immutable in
practice. If a release is defective:

1. Mark the GitHub release as withdrawn in its notes and stop directing users to it.
2. Prepare a corrective patch release (for example, `v0.1.1`) from `main`; do not retag a different commit as `v0.1.0`.
3. Re-run the full gate and consumer smoke test, then publish the corrective tag.
4. If npm publication is enabled later, deprecate a defective package version rather than overwriting it, and document the replacement version.
