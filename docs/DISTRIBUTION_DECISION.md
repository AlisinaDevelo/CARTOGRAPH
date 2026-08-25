# Distribution decision

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
untrusted static input. The release workflow does not publish to npm.

## Evidence

`node scripts/release-artifact.mjs` packs the artifact, verifies its file set,
installs it in an isolated consumer with `npm install --offline
--ignore-scripts`, validates the installed package metadata and public import,
then runs `cartograph --version`, `cartograph --help`, and a representative
scan. Generated output is temporary unless an explicit output directory is
provided.
