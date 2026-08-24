# CARTOGRAPH F-001 product charter evidence

This artifact records the pre-merge device check and the post-merge reproduction
for the public product charter and support matrix. The implementation merge was
performed through the authorized administrator path because GitHub does not allow
the PR author to approve their own pull request.

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

## Post-merge reproduction

- Merged implementation SHA: `d70f7900405e9ab704d359b925daec0ff23049a6`
- Device: MacBook Pro 17,1, Apple M1, 8 GB; macOS 26.6.2 (25G83), arm64
- Toolchains: Node 24.19.0/npm 11.17.0/TypeScript 6.0.3 and Node 26.7.0/npm 11.19.0/TypeScript 6.0.3
- The same full local replacement pipeline passed: 44 tests, coverage thresholds, roadmap validation, 22 roadmap tests, build, package dry-run/install, CLI scan/diff/help/version, invalid-ref recovery, and report resource checks.
- Retained post-merge log: `/Users/alisinakarimi/.codex/evidence/CARTOGRAPH/postmerge-d70f790/pipeline.log`
- Post-merge log SHA-256: `sha256:04433373408ab87784d4ff37c8f1b7f4517cb48d2aea12df0fe969728a2706c5`
- Post-merge package, scan, HTML, Markdown, and invalid-ref artifact digests are recorded in the issue closure comment.
- GitHub Actions were unavailable/no-go and were not used as pass evidence.

## Evidence boundary

This is a documentation contract check; it does not scan a customer repository,
execute fixture code, or use a network service. The merged commit and post-merge
device rerun are recorded in the corresponding GitHub issue.
