# Distribution decision

Current record: `distribution.v0.2`; reviewed 2026-09-27. It supersedes
`distribution.v0.1` (kept below) only in adding npm publication.

## distribution.v0.2: npm through trusted publishing

The attested release tarball may also be published to npm as `cartograph-cli`.
Publication happens only from `.github/workflows/release.yml` on a protected
`v*.*.*` tag, after the full release gate, consumer smoke test, and attestation
verification pass, and only when the repository variable
`CARTOGRAPH_NPM_TRUSTED_PUBLISHING` is `true`. It uses npm trusted publishing:
npm trusts this repository's release workflow through GitHub OIDC, so no npm
token is stored in the repository, its secrets, or a maintainer machine, and
every published version carries npm provenance. The tarball published is the
byte-identical file attached to the GitHub release and listed in `SHA256SUMS`.

npm only allows a trusted publisher to be configured for a package that already
exists, so the maintainer publishes the first version manually with 2FA, then
configures the trusted publisher (repository `AlisinaDevelo/CARTOGRAPH`,
workflow `release.yml`) and sets the repository variable. A defective version
is deprecated, never unpublished or overwritten.

## distribution.v0.1

Decision record: `distribution.v0.1`; reviewed 2026-08-25.

## Decision

CARTOGRAPH v0.1 ships one supported distribution: the packed npm-compatible
tarball attached to a versioned GitHub release. The tarball is installable from
a local path with lifecycle scripts disabled and offline dependency resolution;
its `cartograph` bin, package exports, and Node engine declaration are checked
from the installed artifact before release evidence is accepted.

A standalone native executable is explicitly deferred. Producing and
maintaining platform-specific binaries would add signing, update, provenance,
and support surfaces before adoption evidence justifies that cost. Revisit the
decision only through a new versioned record with representative platform
fixtures, reproducible build evidence, and an explicit security/support owner.

## Safety boundary

No supported install path executes code from the analyzed repository. Package
lifecycle scripts are disabled during the release smoke test, the installed CLI
is run from an isolated consumer directory, and the scan fixture is treated as
untrusted static input. (v0.1: the release workflow does not publish to npm;
see v0.2 above.)

## Evidence

`node scripts/release-artifact.mjs` packs the artifact, verifies its file set,
installs it in an isolated consumer with `npm install --offline
--ignore-scripts`, validates the installed package metadata and public import,
then runs `cartograph --version`, `cartograph --help`, and a representative
scan. Generated output is temporary unless an explicit output directory is
provided.
