# Read-only GitHub Action

`action.yml` exposes the first hosted integration boundary for CARTOGRAPH. It
is intentionally informational: the Action reads a pull request, writes a
concise job summary, and uploads a static HTML/JSON report artifact. It does not
comment, label, merge, change issues, execute repository code, use secrets, or
require write permissions.

## Copy-ready workflow

The complete minimal fixture is in
[`examples/github-action-fixture`](../examples/github-action-fixture). Its
workflow pins checkout and CARTOGRAPH revisions, uses `contents: read`, and
checks out the exact pull-request head with `fetch-depth: 0` so merge-base
resolution is local and deterministic.

```yaml
name: CARTOGRAPH architecture diff

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: AlisinaDevelo/CARTOGRAPH@629ee26cc179f08848b09f8c5caeaaf48f6e134c # D-013
        with:
          comparison: merge-base
```

On a pull request, omitted `base` and `head` inputs resolve to
`github.event.pull_request.base.sha` and `github.event.pull_request.head.sha`,
not moving branch names. Explicit refs can be supplied for a manually invoked
workflow. `merge-base` is the default and fails closed for shallow repositories,
unrelated histories, or multiple merge bases; `direct` remains available for
an explicit two-tree comparison.

The artifact contains `architecture-diff.html` and the canonical
`architecture-diff.json`. The retention default is seven days and can be
changed with `retention-days`. The Action builds the checked-out CARTOGRAPH
source with `npm ci --ignore-scripts` and Node.js 24 before analyzing the caller
repository; the caller's source is parsed but never imported or executed.

## Local verification without hosted Actions

`npm run action:validate` creates a temporary Git repository from the fixture,
creates a base and pull-request head commit, runs the exact CLI comparison in
both JSON and HTML modes, and verifies the comparison metadata and static
report. It performs no network request, Action API call, or GitHub mutation.
