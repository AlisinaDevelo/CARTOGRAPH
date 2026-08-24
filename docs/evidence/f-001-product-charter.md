# CARTOGRAPH F-001 product charter evidence

This artifact records the device check for the public product charter and
support matrix. The roadmap issue remains open until the same command is rerun
against the merged `main` SHA and linked from the issue.

## Device and toolchain

- Evidence ID: `F-001-device-check-20260824`
- Source commit under test: `9ed8c4db03b55d97e101cb02750842fdd9e8761b`
- Device: MacBook Pro 17,1, Apple M1, 8 GB
- OS: macOS 26.6.2 (25G83), arm64
- Node.js: 24.19.0; npm 11.17.0

## Reproduction

```text
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test -- --run test/docs/product-charter.test.ts
```

Observed result: 1 test passed. The contract test checks that the public
charter names the first supported slice and explicit non-goals and that the
support matrix names an owner, review cadence, evidence sources, and the
unsupported/unresolved behavior and review process.

The full exact-SHA check was also rerun on the same device with Node.js
26.7.0/npm 11.19.0: 41 tests passed, coverage thresholds passed, roadmap
validation passed, roadmap tests passed 22/22, and the build passed. The
retained log digest is
`sha256:60e7c76f274f56b93611884d3c298a37ef8d22dfa3e00b3c2d911b9211d5e4c5`.

## Evidence boundary

This is a documentation contract check; it does not scan a customer repository,
execute fixture code, or use a network service. Post-merge device rerun and the
merged commit are recorded in the corresponding GitHub issue before closure.
