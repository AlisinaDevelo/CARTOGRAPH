# Strategy-branch privacy and security review

M-009 records the privacy and security decision for the selected strategy
branch. The review is **accepted for `oss-local-first`** as of 2026-08-25. It
does not authorize a hosted analyzer, team workspace, account, source upload,
automatic collector, or hidden telemetry. The machine-readable review is the
digest-bound [`review.v0.1.json`](../test/fixtures/strategy-security/review.v0.1.json)
validated by `npm run strategy-security:validate` against the
[review schema](../schema/strategy-privacy-security-review.v0.1.schema.json).
Current review digest: `sha256:6d64721736a7fad5eea4f940e366ec7723dd66522b23800ed514366ecec5fb1e`.

## Decision and scope

The selected branch keeps CARTOGRAPH's complete local TypeScript/Express
analyzer, graph and diff contracts, local reports, policy and ADR workflows,
bounded optional runtime reconciliation, adapters, and read-only CI Action.
The local caller remains responsible for authorizing repository reads and
choosing output locations. CARTOGRAPH has no server, authentication system,
tenant store, credential loader, hosted source-processing path, or background
collection process.

The review therefore fixes these scope values:

| Boundary                           | Selected value                      | Why it blocks expansion                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Analyzer network and source upload | Disabled                            | Local analysis and reports are complete without transferring source or graph data. GitHub checkout, dependency installation, and optional artifact upload remain workflow control-plane operations, not a CARTOGRAPH hosted service. |
| Account and tenancy                | No account; no multi-tenant storage | There is no supported operation that needs identity, workspace history, or a remote authorization boundary.                                                                                                                          |
| Repository code execution          | Disabled                            | Parser, Git, archive, and report paths must treat repository input as data, not executable authority.                                                                                                                                |
| Hidden telemetry                   | Prohibited                          | Adoption and strategy evidence is manual public or consented aggregate evidence, not a usage-collection system.                                                                                                                      |
| Hosted/team expansion              | Deferred                            | It would add authorization, retention, incident-response, operational, and cost obligations that the current evidence does not justify.                                                                                              |

The full scope, actors, data-flow inventory, retention rules, abuse cases, and
residual risks are versioned in the fixture. The validator requires the
decision, controls, and rejected collection set to remain explicit and
offline.

## Assets, actors, and trust boundaries

The protected assets are repository source and metadata, graph/diff integrity,
local files and worktrees, developer or CI credentials, reports and artifacts,
shared runner availability, and future release integrity. The principal actors
are:

- the local maintainer or reviewer, who already has operating-system authority
  over the selected repository and output path;
- the repository author or fork contributor, who can supply hostile source,
  configuration, refs, report text, or resource-consuming inputs but cannot
  grant the analyzer new authority;
- the GitHub-hosted runner, which receives only the workflow's read-only
  contents permission and no secrets;
- dependency/release actors, constrained by the lockfile, lifecycle-disabled
  install, pinned Actions, dependency review, CodeQL, and provenance checks;
  and
- a private security reporter, whose reproduction and source stay out of
  public issues.

The local caller's authority is not a tenant boundary: CARTOGRAPH does not
authenticate the caller, and it must not imply that a local report is a hosted
access-control decision. The Action boundary is independent: `pull_request`
workflows use `contents: read`, checkout does not persist credentials, and the
composite Action has no `pull_request_target` path. Optional report artifact
upload is a GitHub workflow choice, not a CARTOGRAPH service.

## Data flows and retention

| Flow                                            | Data and purpose                                                                                                                                    | Storage/retention                                                        | Enforcing controls                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Local source → analyzer                         | Source, compiler configuration, package metadata, and syntax become a canonical local snapshot.                                                     | Bounded process memory; source bodies are not serialized.                | Parser-only loading, root-relative selection, schema/evidence validation, and fail-closed budgets.                   |
| Git refs → temporary revision                   | Validated commits and bounded archives become isolated trees for exact comparison.                                                                  | Ephemeral; cleanup runs on success and failure.                          | Fixed argument arrays, no shell/fetch, merge-base checks, archive/tree/time ceilings.                                |
| Graph/diff → local report                       | Versioned records, relative evidence, diagnostics, and optional local policy/ADR context become JSON/Markdown/HTML.                                 | Caller-selected local file; explicit overwrite/force and symlink checks. | Escaping, CSP, no remote assets, report cardinality/byte limits, no source bodies or absolute paths.                 |
| Fork PR → read-only Action                      | Revisions produce a local diff and optional JSON/HTML artifact through GitHub's workflow network.                                                   | Runner temp is ephemeral; upload is opt-in and defaults to seven days.   | Pinned actions, read-only permissions, no secrets, `persist-credentials: false`, no write-capable target event.      |
| Local policy → evaluator                        | A repository-relative JSON policy produces informational or enforcing exit status.                                                                  | Local memory or the caller-selected CI artifact.                         | Data-only parser; no remote policy, commands, plugins, or authority escalation.                                      |
| Explicit local trace → reconciliation           | Allowlisted OTLP identity/timing fields become bounded runtime classifications.                                                                     | Redacted bounded memory; explicit discard and no collector.              | Input/schema/redaction budgets, uncertainty labels, no listeners, uploads, or background history.                    |
| Reviewed source/dependencies → release artifact | Build output, checksums, SBOM/provenance, and compatibility metadata support a future reproducible release through the privileged release workflow. | No public release in this branch; future artifact metadata only.         | Lockfile, lifecycle-disabled install, pinned Actions, dependency review, CodeQL, package checks, and release review. |

Source and raw runtime or issue payloads are not retained by the review. Local
outputs remain the caller's responsibility. GitHub artifact retention is
controlled by the workflow owner and can be disabled for sensitive
repositories; it is not a hosted CARTOGRAPH history service.

## Review gaps and conditional assumptions

The review is intentionally explicit about controls that are not yet
aggregate, process-wide, or automatically selected. These are not silently
treated as mitigations:

| Question                                                                                 | Resolution                                                                                                                                | Status                                                                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Does `maxWallClockMs` cover every Git operation in a revision diff?                      | No. Revision comparison and path-history use the fixed subprocess timeout rather than the analyzer budget.                                | Gap remains; propagate an aggregate deadline if the ceiling is a release guarantee.                              |
| Does `maxReportItems` cap every materialized graph snapshot before diffing?              | No. Working-tree scan and final rendering are bounded, but materialized snapshots and input arrays are not subject to the same assertion. | Gap remains; add pre-diff cardinality limits if hostile snapshots are supported.                                 |
| Are diff-snapshot files bounded by memory/time/cancellation before parsing?              | No. Concurrent 64 MiB file reads and renderer limits do not establish a process memory or analysis-time ceiling.                          | Gap remains; add a budget if untrusted snapshot files are in scope.                                              |
| Does the Action enforce its documented root and honor repository resource configuration? | No. The root input is not checked against `GITHUB_WORKSPACE`, and the Action exposes no `--config` input.                                 | Gap remains; enforce containment and decide whether consumer budgets are supported before broad Action adoption. |
| Are runtime trace limits identical for CLI and library callers?                          | No. Core library ceilings are higher and have no explicit memory field; library callers remain trusted.                                   | Gap remains; converge contracts or document the trusted-caller boundary.                                         |
| Is adapter isolation automatic?                                                          | No. `runAdapter` is in-process while `runAdapterIsolated` is a separate permissioned path.                                                | Gap remains; untrusted third-party adapters must select isolation explicitly.                                    |
| What protects release permissions?                                                       | The tag workflow intentionally grants contents, identity-token, and attestation write authority.                                          | Gap remains as an operational prerequisite; protect tags/main and the dependency/action chain before release.    |

These questions keep the selected local-first decision honest. They do not
authorize hosted collection or make the current Action a multi-tenant service.
The machine-readable fixture records the same resolutions and source anchors.

## Incident response and supply chain

Suspected vulnerabilities are reported through GitHub private vulnerability
reporting when available or privately to the maintainer. A report should use a
minimal authorized fixture or redacted reproduction, the exact revision and
command, the trust boundary, impact, and a suggested mitigation. Containment
means disabling the affected command or artifact upload, preserving exact
redacted evidence, rotating an external token through its owner, and blocking
release until the boundary is reviewed. The unreleased project makes no fixed
response-time or release-time promise.

Supply-chain controls are currently enforced rather than delegated to the
strategy decision: CI installs with lifecycle scripts disabled; workflow
actions are pinned; the lockfile, dependency review, CodeQL, package contents,
and provenance checks are part of the local/CI pipe. The compiler and npm
dependency chain remain trusted dependencies. No public npm release exists yet,
so a future publication needs its own identity, signing, dependency,
provenance, and incident-response review.

## Abuse cases and blocking mitigations

The cases below are threat scenarios, not claims that a vulnerability is
present. `blocked` means the current control is part of the local boundary;
`required-before-expansion` means the scenario blocks a hosted, team, provider,
automatic-binding, or broader runtime decision; `accepted-residual` records a
known limitation that does not create a new authority in the selected branch.

| Scenario                                                 | Current status              | Capability that must not be gained                                   | Blocking mitigation                                                                                                        |
| -------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Hostile repository code or lifecycle scripts             | `blocked`                   | Execute with caller/runner authority                                 | Parser-only analysis, lifecycle-disabled installs, and offline negative fixtures.                                          |
| Traversal, out-of-root config, or symlinked source       | `blocked`                   | Read outside the selected repository or temp root                    | Realpath containment, repository-relative schemas, and symlink rejection.                                                  |
| Injection-shaped Git refs                                | `blocked`                   | Shell execution, wrong revision, or worktree mutation                | Fixed binaries/argument arrays, ref validation, isolated trees, and no fetch.                                              |
| Output overwrite or symlink                              | `accepted-residual`         | Destroy or disclose a local file                                     | No overwrite by default, symlink preflight, final-component no-follow open; concurrent races remain outside the guarantee. |
| Oversized or high-cardinality input                      | `blocked`                   | Exhaust local or shared CI resources                                 | Source/archive/memory/report/trace/time ceilings, cancellation, cleanup, and workflow timeout.                             |
| Repository-controlled report markup                      | `blocked`                   | Execute or fetch from a reviewer's browser                           | Escaping, no remote assets, restrictive CSP, and adversarial renderer tests.                                               |
| Fork token or workflow write exposure                    | `blocked`                   | Mutate the base repository or read secrets                           | `pull_request`, `contents: read`, no secrets, pinned actions, and fork policy tests.                                       |
| Dependency, Action, runner, or future release compromise | `required-before-expansion` | Alter analysis or distribute a malicious artifact                    | Lockfile, lifecycle-disabled install, pins, dependency review, CodeQL, provenance, and release-specific review.            |
| Optional runtime trace disclosure                        | `required-before-expansion` | Retain source/credential text or turn observations into static facts | Allowlisted fields, redaction, count/byte/time limits, explicit discard, and no collector.                                 |

## Rejected collection and residual risk

The review rejects the following collection or authority paths:

- hosted copies of source, graph snapshots, or raw issue bodies;
- required accounts, tenants, workspaces, or organizational history;
- hidden telemetry, background usage collection, retention measurement, or
  silent network requests;
- automatic OTLP listeners, collectors, or implicit runtime history; and
- provider routing of source, issue text, credentials, or uncertain fields.

These are rejected because the local product is complete without them and the
current scorecard does not contain representative, consented evidence for the
new trust boundaries. A future proposal must publish a public RFC, refresh
privacy/security evidence, publish the sustainability and cost model, audit
claims, define capacity and incident ownership, and receive a separate ADR.

Accepted residuals are explicit: dynamic JavaScript can remain incomplete; the
compiler and npm chain are trusted dependencies; output preflight is not a
concurrent multi-process guarantee; and a GitHub-hosted runner/artifact service
remains an external assumption. None of these residuals authorizes hidden
collection or changes the local-first product boundary.

## Evidence and review trigger

The structured review fixture is source-backed by
[`docs/THREAT_MODEL.md`](THREAT_MODEL.md), [`SECURITY.md`](../SECURITY.md),
the local CLI and Git/report modules, workflow and Action permissions, runtime
trace safety contracts, and the M-005 scorecard/M-006 ADR. The review should be
refreshed when a public RFC proposes a hosted, account-based, team, provider,
automatic-binding, or broader runtime boundary, or when any blocking control
changes.
