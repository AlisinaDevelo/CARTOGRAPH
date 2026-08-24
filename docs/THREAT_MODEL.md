# Threat model

Status: initial design review, 2026-08-24. Revisit this document when runtime
reconciliation, plugins, or a hosted service enter scope.

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
| Crafted source exhausts CPU or memory                       | Denial of service                           | Exclude dependency/build directories, cap source files, source bytes, archive bytes, report cardinality, memory, and wall-clock time; library callers can cancel and revision trees are cleaned in a `finally` path                                                                                                                                                                                                                          | Budget, cancellation, and oversized-input tests                      |
| Malformed graph data creates misleading results             | Tampering                                   | Versioned runtime validation, canonicalization, conflict rejection, evidence invariants                                                                                                                                                                                                                                                                                                                                                      | Schema and property tests                                            |
| A human report executes repository-controlled markup        | Code execution or disclosure                | Escape HTML and Markdown-controlled text; use no repository-provided HTML, remote assets, scripts, or external requests; add a restrictive HTML CSP                                                                                                                                                                                                                                                                                          | Adversarial Markdown and HTML renderer tests                         |
| GitHub Action exposes tokens on fork changes                | Credential theft                            | Use `pull_request`, read-only permissions, no secrets, pinned actions, and no `pull_request_target` execution                                                                                                                                                                                                                                                                                                                                | Workflow policy test and fork smoke test                             |
| Dependency or release compromise                            | Tampering                                   | Lockfile, dependency review, CodeQL, pinned Actions, provenance, package dry-run, and scoped publishing identity                                                                                                                                                                                                                                                                                                                             | CI and release checklist                                             |

## Optional runtime traces

The current core exposes only an inert local OTLP JSON normalizer; it is not
part of the CLI or report surface. No trace collector, OTLP listener, hosted
receiver, upload, or background telemetry process is enabled by default. The
normalizer rejects malformed or oversized input and discards arbitrary
attributes, events, links, payloads, and status messages. The following
additional controls remain mandatory before runtime reconciliation is accepted:

| Trace risk                                                    | Required control                                                                                                                      | Evidence                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Span attributes contain source, credentials, or personal data | Require an explicit local input path, schema validation, configurable redaction, and a documented sensitive-field denylist            | O-001 discarded-attribute fixture; future redaction fixtures and a report scan     |
| Trace history grows without a bound                           | Require user-selected retention and an explicit deletion/compaction operation; never retain traces implicitly                         | Retention and deletion tests with measured output size                             |
| Dynamic edges are mistaken for static facts                   | Classify observations as runtime evidence, preserve trace identifiers only as references, and keep confidence separate from certainty | Reconciliation fixtures covering observed-only, static-only, and conflicting edges |
| Trace input triggers network or code execution                | Parse trace data as inert records; do not load plugins, call URLs, or execute repository code                                         | O-001 offline boundary test and future hostile-record fixture                      |

Until reconciliation, redaction, and retention controls are implemented, runtime
behavior remains an explicit non-goal and the normalized input is not interpreted
as an architectural fact.

## Optional model-provider boundary

The model-provider boundary is design-only and disabled by default. No provider
client, credential loader, or network transport is present in CARTOGRAPH. The
RFC in `docs/MODEL_PROVIDER_PRIVACY.md` defines the future boundary and the
offline fixture validator in `scripts/model-provider-privacy.mjs` checks that
each adversarial case has a no-leak disposition.

| Threat                                      | Control                                                                                                             | Fixture                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Source or issue prompt injection            | Treat all text as untrusted data; never let it select providers, commands, credentials, or policy.                  | `source-prompt-injection`, `issue-prompt-injection` |
| Secret exfiltration                         | Redact locally, send only the exact allowlist, omit uncertain fields, and defer on credential-shaped input.         | `secret-exfiltration`                               |
| Untrusted reports or malicious suggestions  | Keep output unverified and authority-free; reject destructive commands, policy weakening, and unsupported evidence. | `untrusted-report`, `malicious-suggestion`          |
| Provider failure or unavailable policy      | Use typed bounded budgets and explicit deferral; never convert failure into success.                                | `provider-failure`                                  |
| Nondeterminism or misleading confidence     | Record input/response digests and uncertainty; confidence never upgrades evidence.                                  | `nondeterminism`, `misleading-confidence`           |
| Configuration attempts to enable a provider | Use a no-provider default and per-request user consent; repository files cannot opt in.                             | `no-provider-default`                               |

Raw source, issue bodies, credentials, absolute paths, credential-bearing URLs,
and provider tokens are not eligible for transmission. A future provider
adapter must pass these fixtures plus transport, retention, deletion, and
independent red-team review before integration.

## Default offline behavior

The `scan`, `diff`, and `diff-snapshots` commands make no network requests, use no hidden
telemetry, and perform no source execution. They read local source or materialized Git
trees, invoke only fixed Git arguments for revision analysis, and render local output. A
repository can contain imports, `fetch` calls, lifecycle scripts, or hostile text without
causing those operations to run during analysis.

The offline boundary is verified by the repository-code execution test in
`test/security/offline.test.ts`, static report tests, Git argument tests, and the exact
device reproduction recorded in `docs/evidence/f-001-product-charter.md`. A future trace
reconciliation adapter must add a separate opt-in test and update this threat model before
it is included in the support matrix.

## Accepted residual risks

Static analysis is incomplete for dynamic JavaScript. CARTOGRAPH mitigates this with diagnostics and confidence labels; it does not claim completeness. The TypeScript compiler and npm dependency chain remain trusted dependencies and require ongoing patching and release review.

## Security gates

Before accepting arbitrary repositories in a reusable GitHub Action:

- validate repository-derived path containment and output-path symlink preflight plus final-component no-follow semantics, with concurrent filesystem changes outside the guarantee;
- preserve the enforced resource ceilings and cancellation behavior in every new adapter;
- prove repository code and lifecycle scripts do not execute;
- verify report escaping and offline behavior;
- test fork pull requests with least-privilege permissions;
- run a dependency and workflow supply-chain review.
