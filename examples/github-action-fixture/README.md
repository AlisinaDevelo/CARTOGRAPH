# CARTOGRAPH Action fixture

This is a minimal TypeScript repository for exercising the read-only
CARTOGRAPH GitHub Action. Copy this directory into a repository root (including
`.github/workflows/cartograph.yml`), commit the fixture, and open a pull
request that changes a file under `src/`.

The workflow checks out the pull-request head with complete history, resolves
the event's exact base and head SHAs, and runs the Action in its explicit
informational-by-default mode. It writes a concise job summary and uploads a
static HTML/JSON report artifact.
It deliberately uses `pull_request`, not `pull_request_target`, so fork runs
receive only a read-only contents token and no repository secrets. It does not
comment on the pull request, modify issues, or pass credentials to the analyzer.

The local Action security harness additionally checks malicious package scripts,
symlinked outputs, oversized input, cancellation, and missing revision refs.

The artifact is retained for seven days by default and contains only the
canonical JSON and escaped HTML reports. To opt into local policy evaluation,
add `policy: .cartograph/policy.json`; it remains informational unless
`policy-mode: enforce` is also supplied. Enforced findings return exit code 2.
The optional policy report is uploaded separately. For a sensitive repository,
add `upload-report: false` to keep the summary while skipping artifact upload.
Reports never include source bodies, source snippets, tokens, absolute local
paths, or arbitrary payloads.
