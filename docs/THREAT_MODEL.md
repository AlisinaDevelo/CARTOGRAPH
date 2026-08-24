# Threat model

Status: initial design review, 2026-08-23. Revisit this document when CI, plugins, runtime traces, or a hosted service enter scope.

## System and trust boundaries

CARTOGRAPH accepts an untrusted repository path, configuration, Git history, TypeScript syntax, and package metadata. The caller also chooses an output path. The analyzer process, Git and archive subprocesses, temporary revision trees, generated reports, package dependencies, and CI runner are trust boundaries.

The current design has no authentication, server, cloud storage, or telemetry boundary.

## Protected assets

- source code and repository metadata;
- local files outside the selected repository;
- developer and CI credentials;
- integrity of graph and diff results;
- developer worktrees and Git history;
- CI availability and resource budgets.

## Threats and controls

| Threat                                                      | Risk                                        | Initial control                                                                                                                                                                                                                                                                                                                                                                                                                              | Validation                                                           |
| ----------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Repository code executes during analysis                    | Elevation of privilege and credential theft | Parse source without importing modules, running lifecycle scripts, builds, or arbitrary plugins                                                                                                                                                                                                                                                                                                                                              | Negative fixture and subprocess boundary tests                       |
| Repository-derived paths escape the repository or temp root | Disclosure of local files                   | Resolve and validate repository and configuration roots, store only relative evidence paths, and reject absolute or traversal evidence paths and archived symbolic links                                                                                                                                                                                                                                                                     | Unit tests for absolute, `..`, configuration-path, and symlink cases |
| An output path overwrites an existing local file            | Data loss                                   | Treat the output path as an explicit caller choice, refuse overwrite by default, require `--force`, reject a final symlink and any existing user-controlled symlinked parent component during preflight (apart from macOS's standard `/tmp` and `/var` root aliases), open the final component with no-follow semantics, and create new files with private permissions; do not claim race-free protection from concurrent filesystem changes | Output-file and symlink tests                                        |
| Git refs or arguments become shell commands                 | Command execution                           | Spawn fixed binaries with argument arrays and no shell; verify refs before archive                                                                                                                                                                                                                                                                                                                                                           | Injection-shaped ref tests                                           |
| Analysis alters the worktree                                | Tampering and data loss                     | Use read-only Git commands and isolated archive directories; never checkout, reset, clean, or stash                                                                                                                                                                                                                                                                                                                                          | End-to-end dirty-worktree hash/status test                           |
| Source or secrets leak into snapshots/reports               | Information disclosure                      | Omit source bodies and absolute paths; escape output; no network requests or telemetry                                                                                                                                                                                                                                                                                                                                                       | Snapshot redaction and static-report network tests                   |
| Crafted source exhausts CPU or memory                       | Denial of service                           | Currently exclude dependency/build directories, cap snapshot inputs and subprocess output, and bound CI time; file-count, analysis-time, archive-size, and memory ceilings remain release gates                                                                                                                                                                                                                                              | Budget and oversized-input tests before v0.1                         |
| Malformed graph data creates misleading results             | Tampering                                   | Versioned runtime validation, canonicalization, conflict rejection, evidence invariants                                                                                                                                                                                                                                                                                                                                                      | Schema and property tests                                            |
| A human report executes repository-controlled markup        | Code execution or disclosure                | Escape HTML and Markdown-controlled text; use no repository-provided HTML, remote assets, scripts, or external requests; add a restrictive HTML CSP                                                                                                                                                                                                                                                                                          | Adversarial Markdown and HTML renderer tests                         |
| GitHub Action exposes tokens on fork changes                | Credential theft                            | Use `pull_request`, read-only permissions, no secrets, pinned actions, and no `pull_request_target` execution                                                                                                                                                                                                                                                                                                                                | Workflow policy test and fork smoke test                             |
| Dependency or release compromise                            | Tampering                                   | Lockfile, dependency review, CodeQL, pinned Actions, provenance, package dry-run, and scoped publishing identity                                                                                                                                                                                                                                                                                                                             | CI and release checklist                                             |

## Optional runtime traces

Runtime trace ingestion is not part of the current CLI or report surface. No trace
collector, OTLP listener, hosted receiver, or background telemetry process is enabled by
default. The following controls become mandatory before a local trace input is accepted:

| Trace risk                                                    | Required control                                                                                                                      | Evidence                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Span attributes contain source, credentials, or personal data | Require an explicit local input path, schema validation, configurable redaction, and a documented sensitive-field denylist            | Redaction fixtures and a report scan proving raw attributes are absent             |
| Trace history grows without a bound                           | Require user-selected retention and an explicit deletion/compaction operation; never retain traces implicitly                         | Retention and deletion tests with measured output size                             |
| Dynamic edges are mistaken for static facts                   | Classify observations as runtime evidence, preserve trace identifiers only as references, and keep confidence separate from certainty | Reconciliation fixtures covering observed-only, static-only, and conflicting edges |
| Trace input triggers network or code execution                | Parse trace data as inert records; do not load plugins, call URLs, or execute repository code                                         | Offline boundary test and a hostile-record fixture                                 |

Until those controls and tests exist, runtime behavior remains an explicit non-goal and
unsupported input rather than an implied capability.

## Default offline behavior

The `scan`, `diff`, and `diff-snapshots` commands make no network requests, use no hidden
telemetry, and perform no source execution. They read local source or materialized Git
trees, invoke only fixed Git arguments for revision analysis, and render local output. A
repository can contain imports, `fetch` calls, lifecycle scripts, or hostile text without
causing those operations to run during analysis.

The offline boundary is verified by the repository-code execution test in
`test/security/offline.test.ts`, static report tests, Git argument tests, and the exact
device reproduction recorded in `docs/evidence/f-001-product-charter.md`. A future trace
adapter must add a separate opt-in test and update this threat model before it is included
in the support matrix.

## Accepted residual risks

Static analysis is incomplete for dynamic JavaScript. CARTOGRAPH mitigates this with diagnostics and confidence labels; it does not claim completeness. The TypeScript compiler and npm dependency chain remain trusted dependencies and require ongoing patching and release review.

## Security gates

Before accepting arbitrary repositories in a reusable GitHub Action:

- validate repository-derived path containment and output-path symlink preflight plus final-component no-follow semantics, with concurrent filesystem changes outside the guarantee;
- add resource ceilings and cancellation;
- prove repository code and lifecycle scripts do not execute;
- verify report escaping and offline behavior;
- test fork pull requests with least-privilege permissions;
- run a dependency and workflow supply-chain review.
