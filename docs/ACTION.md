# Read-only GitHub Action

`action.yml` exposes the first hosted integration boundary for CARTOGRAPH. It
is intentionally informational: the Action reads a pull request, writes a
concise job summary, and uploads a static HTML/JSON report artifact. It does not
comment, label, merge, change issues, execute repository code, use secrets, or
require write permissions.

## Fork pull requests and permissions

The copy-ready workflow uses `pull_request`, never `pull_request_target`. A
pull request from a public fork therefore runs with GitHub's read-only token
boundary and does not receive repository secrets. The workflow and job both
declare only `contents: read`; they do not grant `actions`, `issues`,
`pull-requests`, or other write permissions.

The checkout disables credential persistence and checks out the event's exact
head SHA. The analyzer receives only explicit repository-relative inputs and
the two event SHAs; no token or secret is placed in its environment. The
Action itself is referenced by an immutable commit SHA, and its checkout and
artifact-upload dependencies are pinned to commit SHAs as well. A workflow
file changed by a fork is still untrusted code, so maintainers should treat
its job output and uploaded report as review material, not as an authorization
or merge decision.

## Pin and update policy

Consumer workflows should pin CARTOGRAPH and every third-party Action to a
full commit SHA with a human-readable version comment. Dependabot checks npm
updates weekly and GitHub Actions monthly, waits seven days before proposing
updates, and never merges them automatically. Maintainers review the pinned
diff, security impact, and the fork security harness before merging an update.

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
report. `npm run action:security:validate` checks the copy-ready workflow and a
synthetic fork pull-request event for the read-only permission, exact-SHA,
no-secret, and no-`pull_request_target` invariants. These checks perform no
network request, Action API call, or GitHub mutation.
