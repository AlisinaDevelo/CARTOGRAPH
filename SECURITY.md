# Security policy

CARTOGRAPH is an unreleased, local-first TypeScript analyzer. It accepts untrusted repository paths, configuration, Git history, TypeScript syntax, package metadata, and output paths. The analyzer process, Git and archive subprocesses, temporary revision trees, generated reports, package dependencies, and CI runner are security boundaries.

No hosted service, authentication system, telemetry pipeline, or npm release process is currently part of the supported product. Do not assume that an unreleased build is suitable for processing sensitive repositories without an independent review.

## Reporting a vulnerability

Please do not open a public issue or discussion for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/AlisinaDevelo/CARTOGRAPH/security/advisories/new) when it is enabled for this repository. If that form is unavailable, contact the maintainer privately through the [AlisinaDevelo GitHub profile](https://github.com/AlisinaDevelo). Do not include secrets or proprietary source in the initial report; a minimal fixture or a redacted reproduction is preferred.

Include, where possible:

- the affected commit, version, or workflow;
- the affected command, configuration, input shape, and operating system;
- a minimal reproduction or safe proof of concept;
- the impact and the trust boundary involved;
- any suggested mitigation.

The maintainer will assess reports and coordinate a practical disclosure and remediation plan. Do not rely on a fixed response-time or release-time promise while the project is unreleased.

## Supported versions

| Version               | Security support                                              |
| --------------------- | ------------------------------------------------------------- |
| `main` / `Unreleased` | Current development baseline; fixes are considered here first |
| Published releases    | None yet                                                      |

## Scope

Reports are especially valuable for issues involving:

- execution of repository code, package lifecycle scripts, plugins, or unexpected network requests during analysis;
- absolute paths, traversal, symlink, temporary-root, or output-path escapes;
- Git refs or subprocess arguments being interpreted as shell commands;
- worktree changes, destructive Git operations, or loss of Git history;
- source, credentials, absolute paths, or other sensitive data leaking into snapshots or reports;
- HTML or report output enabling script execution, external requests, or disclosure;
- crafted inputs causing unbounded CPU, memory, recursion, file-count, report-size, or CI-time use;
- malformed graph data producing unsafe or misleading canonical results;
- GitHub workflow permissions, fork pull requests, action pinning, or token exposure;
- dependency, package, or future release-integrity problems.

The current threat model and its validation gates are documented in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). Static analysis is intentionally incomplete for dynamic JavaScript; an imprecise result is not automatically a security vulnerability, but fabricated evidence or a violation of the documented trust boundaries should be reported.

Output-path symlink checks are preflight checks: CARTOGRAPH rejects a final output symlink and any existing user-controlled symlinked parent component (apart from macOS's standard `/tmp` and `/var` root aliases), and opens the final component with no-follow semantics. These checks do not claim race-free protection against concurrent filesystem changes.

## Safe testing

Test only against repositories and data you are authorized to use. Do not attempt credential access, destructive worktree operations, denial-of-service testing against shared CI, or public exploitation. Stop testing and report privately if a reproduction could expose real data or credentials.
