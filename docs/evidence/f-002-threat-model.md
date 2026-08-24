# CARTOGRAPH F-002 threat-model evidence

This artifact records the pre-merge device verification and the post-merge
reproduction for the threat model and privacy data-flow review. The implementation
merge was performed through the authorized administrator path because GitHub does
not allow the PR author to approve their own pull request.

## Device and toolchain

- Evidence ID: `F-002-device-check-20260824`
- Source commit under test: `34f21a7ccb476a7404311235773b303977fc0a44`
- Device: MacBook Pro 17,1, Apple M1, 8 GB
- OS: macOS 26.6.2 (25G83), arm64
- Node.js 24.19.0 / npm 11.17.0 / TypeScript 6.0.3
- Node.js 26.7.0 / npm 11.19.0 / TypeScript 6.0.3

## Acceptance-criterion mapping

| F-002 criterion                                                                                                                                | Retained evidence                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Threat model covers CLI, parser inputs, report generation, GitHub tokens, fork pull requests, dependencies, path leakage, and optional traces. | `docs/THREAT_MODEL.md`; `test/docs/threat-model.test.ts`; the threat/control table and optional-trace boundary are included in the exact-SHA pipeline log.                                                                               |
| Mitigations and security tests are mapped, and default network-offline behavior is verified.                                                   | `test/security/offline.test.ts`; existing path, symlink, Git-argument, dirty-worktree, report-escaping, and revision-recovery tests; the offline behavior section in `docs/THREAT_MODEL.md`; local CLI failure/recovery artifacts below. |

## Exact-SHA local pipeline

GitHub Actions are unavailable for the requested week. No remote workflow result
was used as pass evidence; the remote CI status is an explicit **no-go/unavailable**
limitation. The replacement run was performed locally on the target Mac:

```text
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --ignore-scripts --no-audit --no-fund
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run check
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The Node 24 and Node 26 `check` runs each passed formatting, ESLint, TypeScript
type-checking, 44 Vitest tests with coverage thresholds, roadmap validation
(20 milestones, 36 labels, 179 issues, 514 dependency edges), 22 roadmap tests,
and the production build. Coverage was 85.59% statements, 70.64% branches,
92.64% functions, and 87.60% lines.

The same run also verified a clean install with lifecycle scripts disabled,
`npm pack --dry-run` with 60 permitted package files and no generated, secret, or
test paths, absence of install lifecycle hooks, tarball installation in an
isolated consumer, `cartograph --version`, `cartograph --help`, a fixture scan,
and an HTML revision diff.

## Security, privacy, failure, recovery, and resource checks

- The hostile-source offline test contains a top-level file write and a `fetch`
  call; analysis did not create the marker file and did not call `fetch`.
- Static reports were checked for absence of script, link, image, and remote
  resource tags. Source bodies and absolute paths remain outside the graph/report
  contract.
- Invalid Git revisions returned exit code 1 with a bounded Git diagnostic. The
  demo repository status was byte-for-byte unchanged afterward, and a valid diff
  succeeded immediately after the failed call.
- Output overwrite refusal, final-output symlink refusal, symlinked-parent
  refusal, unsafe refs, archived symlinks, dirty-worktree preservation, and
  cleanup-on-error are covered by the existing test suite.
- A sparse snapshot larger than 64 MiB is rejected before parsing by the new
  resource-limit regression in `test/cli/commands.test.ts`.
- No additional hardware was required for this static/offline review; the target
  Mac was available. Performance and memory ceilings beyond the 64 MiB snapshot
  guard remain future release gates.

## Retained artifacts

The private evidence bundle is retained at:

```text
/Users/alisinakarimi/.codex/evidence/CARTOGRAPH/F-002-device-check-20260824/
```

| Artifact                   | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `pipeline.log`             | `da216b33d7d87ebe21c7f421e16affa8f5a192d3050dc605b7a3c5c238f63fc3` |
| `cartograph-cli-0.1.0.tgz` | `35b75395a7c16d086823998c231cd9458e62d2af2f24132ba83f5ba924232882` |
| `scan.json`                | `54b659a7a3e7975740d0192a715ae92a2b94ec3aa064c7c3104f08d4f179eea3` |
| `architecture-diff.html`   | `da0442b86a5a5edd940b4d79b8bfbb2e380076ee8e8b041a6df641a7504f2d6c` |
| `architecture-diff.md`     | `130c81a1f7e4f38d0730278924363304ea52f9950f8de921f991089a231ed6c2` |
| `invalid-ref.stderr`       | `65433ea7e08a5af7103a057136d0a37b4c8babb27bd8bbaf85cf5568e3ae8983` |

## Remaining closure gates

The implementation PRs are merged to protected `main`; the merged implementation
SHA is `d70f7900405e9ab704d359b925daec0ff23049a6`. The same local replacement
pipeline was rerun against that SHA and passed on the target device. GitHub
Actions and Copilot were unavailable/no-go and were not used as pass evidence;
the review record is a manual review comment because GitHub rejects author
self-approval. Issue closure comments contain the merged SHA, post-merge log,
artifact digests, and this limitation.

The private post-merge bundle is retained at
`/Users/alisinakarimi/.codex/evidence/CARTOGRAPH/postmerge-d70f790/`.
