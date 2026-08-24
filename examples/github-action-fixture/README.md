# CARTOGRAPH Action fixture

This is a minimal TypeScript repository for exercising the read-only
CARTOGRAPH GitHub Action. Copy this directory into a repository root (including
`.github/workflows/cartograph.yml`), commit the fixture, and open a pull
request that changes a file under `src/`.

The workflow checks out the pull-request head with complete history, resolves
the event's exact base and head SHAs, and runs the Action in informational mode.
It writes a concise job summary and uploads a static HTML/JSON report artifact.
It deliberately uses `pull_request`, not `pull_request_target`, so fork runs
receive only a read-only contents token and no repository secrets. It does not
comment on the pull request, modify issues, or pass credentials to the analyzer.
