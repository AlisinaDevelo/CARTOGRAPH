# Safe policy and ADR workflow

This is the shortest path from an exploratory architecture scan to a reviewed,
local policy check. Every step reads repository files and emits an artifact; no
step uploads source, executes project code, edits a worktree, changes policy, or
merges a pull request.

## 1. Scan a working tree

Build the source checkout and create a private output directory:

```sh
npm ci --ignore-scripts
npm run build
mkdir -p .cartograph
node dist/cli.js scan . --output .cartograph/current.graph.json
```

The snapshot is canonical JSON. It contains typed nodes, relationships, source
evidence, and explicit diagnostics for constructs the analyzer cannot prove.
Treat repository input as untrusted and review the [threat model](THREAT_MODEL.md)
before scanning sensitive source.

## 2. Compare exact revisions and link decisions

Use immutable commit IDs (or locally resolved refs) for a reviewable diff:

```sh
node dist/cli.js diff . \
  --base origin/main \
  --head HEAD \
  --comparison merge-base \
  --adr adr.json \
  --format html \
  --output .cartograph/architecture-diff.html
```

`adr.json` is the repository-local ADR reference index described in
[`ADR_REFERENCES.md`](ADR_REFERENCES.md). Markdown and standalone HTML reports
show the ADR ID, title, lifecycle status, file, graph IDs, source evidence, and
added/removed/changed/unchanged reference states. Missing files, missing graph
IDs, and mismatched ADR Markdown metadata are shown as stale diagnostics. The
JSON diff remains the canonical GraphDiff v1 artifact.

## 3. Observe policy before enforcing it

Start with informational mode against a canonical snapshot or diff:

```sh
node dist/cli.js policy . \
  --policy cartograph-policy.json \
  --snapshot .cartograph/current.graph.json \
  --adr adr.json \
  --mode informational \
  --output .cartograph/policy-evaluation.json
```

Informational findings return exit code `0` and remain visible in the report.
After the findings and evidence are reviewed, the same local policy can be
run with `--mode enforce`; valid violations return exit code `2` and malformed
inputs still fail with exit code `1`. Policy composition, exceptions, and ADR
bindings remain repository-local; no hosted policy or ADR service is consulted.
See [`POLICIES.md`](POLICIES.md) and [`POLICY_ADR_BINDINGS.md`](POLICY_ADR_BINDINGS.md).

## 4. Migrate historical snapshots explicitly

Legacy GraphSnapshot v0 artifacts require a reviewable migration report:

```sh
node dist/cli.js migrate-snapshot old.graph.json \
  --output .cartograph/migrated.graph.json \
  --report .cartograph/migration-report.json
```

Review the identity and evidence changes in the report before using the v1
snapshot as a baseline. Unknown or retired versions fail closed. See the
[migration matrix](IDENTITY_MIGRATION.md).

## 5. Keep remediation review human-controlled

If a separate system produced a bounded remediation suggestion, evaluate its
review record without applying anything:

```sh
node dist/cli.js review-remediation review.json \
  --as-of 2030-01-01T00:00:00.000Z \
  --output .cartograph/review-report.json
```

The result records the state, reviewer/evidence revision, validation, and
expiry while retaining `readOnly: true`, `autoApply: false`, and
`mergeAutomation: false`. CARTOGRAPH never applies the suggestion or treats an
ADR link as proof that implementation intent is correct. See
[`REMEDIATION_REVIEW.md`](REMEDIATION_REVIEW.md).

## 6. Run the same path in CI

The checked-in workflow fixture runs the scan, revision diff with ADR output,
informational policy evaluation, snapshot migration, and read-only review in
an isolated temporary repository:

```sh
npm run workflow:validate
```

It is part of `npm run check` and the Node 22/24 CI matrix. The fixture asserts
that source-controlled files remain unchanged and makes no network requests.
The separate read-only [GitHub Action guide](ACTION.md) explains the fork-safe
permissions and artifact boundaries for pull requests.

## Limits and trust boundary

- A graph edge carries source evidence or an explicit unresolved reason; a
  plausible-looking result outside the support matrix is not a support claim.
- Static analysis does not observe runtime behavior, prove business intent, or
  establish that an ADR is correct. ADR references are traceability records.
- Policy is a local finding gate, not authorization. Informational output should
  be reviewed before enabling enforcement.
- Reports are bounded and self-contained. Narrow the compared change set when
  resource limits are reached instead of truncating output.
