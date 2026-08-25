# Read-only GitHub Action

`action.yml` exposes the first hosted integration boundary for CARTOGRAPH. With
its defaults it is informational: the Action reads a pull request, writes a
concise job summary, and (unless opted out) uploads a static HTML/JSON report
artifact. A repository can opt into local policy evaluation with the `policy`
input and opt into blocking findings with `policy-mode: enforce`. The Action
never comments, labels, merges, changes issues, executes repository code, uses
secrets, or requires write permissions.

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
          retention-days: 7
```

On a pull request, omitted `base` and `head` inputs resolve to
`github.event.pull_request.base.sha` and `github.event.pull_request.head.sha`,
not moving branch names. Explicit refs can be supplied for a manually invoked
workflow. `merge-base` is the default and fails closed for shallow repositories,
unrelated histories, or multiple merge bases; `direct` remains available for
an explicit two-tree comparison.

The architecture report artifact is deliberately scoped to exactly two files:
`architecture-diff.html` and the canonical `architecture-diff.json`. An
opted-in policy produces a separate canonical `policy-evaluation.json` artifact.
Neither artifact ever contains a source body, source snippet, credential, token,
absolute local path, or arbitrary payload. Source evidence is limited to repository-relative paths,
spans, detector identities, and content hashes; HTML values are escaped and the
report has a 16 MiB byte ceiling plus node, edge, and diagnostic cardinality
ceilings. The retention default is seven days; GitHub's supported range is 1–90
days, and repositories should choose the shortest useful value.

Sensitive repositories can keep the job summary while opting out of artifact
upload entirely:

```yaml
with:
  upload-report: false
```

`upload-report` defaults to `true`. The Action still validates the retention
input and produces the report in the runner's temporary directory for the local
rendering step, but no artifact is uploaded when the opt-out is set.

## Optional policy gate

Policy evaluation is disabled unless `policy` names a repository-relative JSON
file. When enabled, `policy-mode` defaults explicitly to `informational`: the
Action records violations in the job summary and succeeds. Set
`policy-mode: enforce` to make a valid report with violations or unsupported
rules fail with the stable policy findings status (exit code 2). Invalid policy,
input, or output errors remain tool failures (exit code 1). A policy report is
written to a separate `*-policy` artifact when report upload is enabled.

```yaml
with:
  policy: .cartograph/policy.json
  policy-mode: enforce
```

The policy input is read locally inside the analyzed repository. The Action
does not fetch policy content or execute policy expressions. Leaving `policy`
empty keeps the read-only architecture diff behavior without a policy gate.

The Action builds the checked-out CARTOGRAPH source with
`npm ci --ignore-scripts` and Node.js 24 before analyzing the caller repository;
the caller's source is parsed but never imported or executed.

## Local verification without hosted Actions

`npm run action:validate` creates a temporary Git repository from the fixture,
creates a base and pull-request head commit, runs the exact CLI comparison in
both JSON and HTML modes, and verifies the comparison metadata, static report,
redaction boundary, and report-size ceiling. `npm run action:security:validate`
checks the copy-ready workflow and a synthetic fork pull-request event for the
read-only permission, exact-SHA, no-secret, no-`pull_request_target`, retention,
and sensitive-repository opt-out invariants. The offline fixture also exercises a
malicious package `preinstall` script (with scripts disabled), symlinked output,
an oversized source file, an already-cancelled analysis, and a missing revision
ref; every case must fail closed without modifying the fixture. The policy test
rejects workflow write permissions, unpinned `uses:` references, and
secret-dependent analysis paths. These checks perform no network request, Action
API call, or GitHub mutation.
