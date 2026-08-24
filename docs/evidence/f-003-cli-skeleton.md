# CARTOGRAPH F-003 CLI/package evidence

This artifact records the device verification for the installable TypeScript
CLI/package skeleton. The issue remains open until its PR is reviewed and merged
to protected `main`, then the same reproduction is rerun against that merged
SHA.

## Device and toolchain

- Evidence ID: `F-003-device-check-20260824`
- Source commit under test: `064df2306c5e0ef1e5ba67d69f5f732222a04e3e`
- Device: MacBook Pro 17,1, Apple M1, 8 GB
- OS: macOS 26.6.2 (25G83), arm64
- Node.js 24.19.0 / npm 11.17.0 / TypeScript 6.0.3
- Node.js 26.7.0 / npm 11.19.0 / TypeScript 6.0.3

## Acceptance-criterion mapping

| F-003 criterion                                                                                                            | Retained evidence                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A clean checkout supports `npm ci`, tests, package creation, `cartograph --help`, and `cartograph --version`.              | Exact local pipeline log; 47 tests; clean installs with `--ignore-scripts`; 60-file package dry-run and isolated tarball install; installed CLI help/version smoke. |
| Supported LTS policy and stable top-level exit behavior are documented, and a no-op scan does not execute repository code. | `docs/CLI.md`; README link; `test/docs/cli-contract.test.ts`; `test/cli/entrypoint.test.ts`; the no-op fixture proved its marker file was not created.              |

## Local replacement pipeline

GitHub Actions and Copilot are unavailable/no-go for the requested period and
were not used as pass evidence. The replacement was run locally on the target
Mac with clean installs under Node 24 and Node 26. Both complete checks passed:

- 47 Vitest tests and coverage thresholds: 85.59% statements, 70.64% branches,
  92.64% functions, and 87.60% lines;
- roadmap validation (20 milestones, 36 labels, 179 issues, 514 dependency
  edges), 22 roadmap tests, and production build;
- `npm pack --dry-run --ignore-scripts` with 60 permitted files and isolated
  consumer installation;
- installed `cartograph --version`, `cartograph --help`, and a schema-valid
  no-op scan;
- invalid top-level input returned exit code 1 with a stable diagnostic, while
  valid commands returned exit code 0.

## Retained artifacts

Private evidence bundle:

```text
/Users/alisinakarimi/.codex/evidence/CARTOGRAPH/F-003-device-check-20260824/
```

| Artifact                   | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `pipeline.log`             | `bcda3d2e66a67025b2b1355d852d31b3c70937554f84b8b66060319a53cf96ab` |
| `cartograph-cli-0.1.0.tgz` | `68416782a2fa123767626ce1f271526e06591b2c468dd301cf7b2ece8a54351c` |
| `scan.json`                | `54b659a7e3a7975740d0192a715ae92a2b94ec3aa064c7c3104f08d4f179eea3` |

No additional hardware was required for this local CLI/package review; the
target Mac was available. The package is not yet published to npm, so the
consumer smoke uses the locally generated tarball.
