# Quickstart and limitations

This guide gets a clean CARTOGRAPH checkout to its first local report without
installing or executing the sample repository. The tool is pre-alpha and
intentionally makes a bounded support claim; read the [support matrix](SUPPORT_MATRIX.md)
and [threat model](THREAT_MODEL.md) before analyzing sensitive code.

## Prerequisites

- Node.js 22.13 or newer (Node 22 and 24 are the supported LTS lines).
- npm and Git.
- A clean CARTOGRAPH checkout.

From the checkout root:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
node dist/cli.js --version
```

## First scan

The [sample repository](../examples/sample-repository/) is a small NodeNext
TypeScript project. Scan it into a new, private output directory:

```sh
mkdir -p .cartograph
node dist/cli.js scan examples/sample-repository \
  --output .cartograph/sample.graph.json
```

The JSON artifact is canonical and contains repository-relative evidence. CARTOGRAPH
does not import the sample, run its package scripts, contact a network, or write
inside the sample directory.

## First revision diff

`diff` needs two local Git revisions. The following makes a disposable copy,
creates a baseline, adds one source export, and renders a self-contained HTML
report:

```sh
sample_root="$(mktemp -d /tmp/cartograph-sample.XXXXXX)"
cp -R examples/sample-repository/. "$sample_root/"
git -C "$sample_root" init --initial-branch=main
git -C "$sample_root" config user.name "CARTOGRAPH sample"
git -C "$sample_root" config user.email "sample@cartograph.invalid"
git -C "$sample_root" add .
git -C "$sample_root" commit -m "sample baseline"
printf '\nexport const changed = true;\n' >> "$sample_root/src/app.ts"
git -C "$sample_root" add src/app.ts
git -C "$sample_root" commit -m "sample change"
node dist/cli.js diff "$sample_root" \
  --base main \
  --head HEAD \
  --comparison direct \
  --format html \
  --output .cartograph/sample-diff.html
```

The disposable copy can be removed after reviewing the report. `merge-base` is
the pull-request mode; it requires a full, non-shallow history and a unique
merge base. Use `direct` only when comparing two explicitly chosen trees.

## Configuration

Use `--tsconfig <path>` to select a project configuration, or `--config <path>`
for the repository-relative [configuration contract](CONFIGURATION.md). Resource
ceilings are deliberate safety controls; lower them for an untrusted large
repository rather than disabling the boundary. Output paths are created with
private permissions, reject unsafe symlink paths, and are never overwritten
without `--force`.

## Privacy and unsupported input

Analysis is local and offline: no telemetry, network request, package lifecycle
script, build, or module import is performed. Reports contain paths, spans,
detector identities, and content hashes, not source bodies. Review
[SECURITY.md](../SECURITY.md) and the [privacy/security section](../README.md#privacy-and-security)
before processing sensitive code.

The first analyzer supports bounded TypeScript and Express constructs listed in
the [support matrix](SUPPORT_MATRIX.md). JavaScript, generated routes,
framework metaprogramming, dynamic destinations, and unresolved calls remain
explicit diagnostics or are excluded; a plausible graph outside the matrix is
not a support claim.

## Troubleshooting

| Symptom                                             | Action                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `merge-base` reports a shallow or unrelated history | Re-fetch the full history (`fetch-depth: 0`) or use `direct` for two explicit commits.                  |
| A route, import, or call is not an edge             | Check the support matrix and the report diagnostic; dynamic input is never guessed.                     |
| A config or tsconfig path is rejected               | Use a repository-relative path from the analyzed root and validate the JSON contract.                   |
| The output already exists or a symlink is rejected  | Choose a new output path, or pass `--force` only after reviewing the target.                            |
| A report hits a resource limit                      | Reduce the analyzed scope or tune the documented ceilings; do not treat a truncated report as complete. |

## GitHub Action

The [read-only Action guide](ACTION.md) includes a copy-ready workflow, exact
revision semantics, fork-token behavior, pinned dependencies, and local
security validation. It uses `pull_request`, `contents: read`, no secrets, and
an uploaded informational artifact; it never comments, labels, merges, or
changes issues. The [release process](RELEASE.md) covers package artifacts and
rollback without requiring npm publication.
