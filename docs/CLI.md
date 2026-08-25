# CLI runtime and exit policy

CARTOGRAPH is a local, deterministic command-line tool. The package entrypoint
is `cartograph`; a source checkout can invoke the same entrypoint with
`node dist/cli.js` after `npm run build`.

## Supported LTS policy

CARTOGRAPH supports the active and maintenance LTS Node.js lines used by the
project’s release checks:

- Node.js 22, beginning with 22.13.0;
- Node.js 24.

The package declares `node >=22.13.0`. Every release check runs the complete
local test, coverage, roadmap, and build pipeline on Node.js 22 and 24 where
those runtimes are available. A new LTS line is added only after the same
device/package checks pass and the support matrix is updated. Odd-numbered or
unlisted Node.js lines may work but are not a support claim.

## Installation and package smoke

A clean checkout is expected to work without lifecycle scripts:

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run --ignore-scripts
npm run build
node dist/cli.js --help
node dist/cli.js --version
```

The published file set is limited to the built `dist` tree, package metadata,
changelog, license, notice, and README. A release check installs the generated tarball in
an isolated consumer before treating the `cartograph` bin as usable.

`scan` and `diff` accept `--config <path>` for the versioned
[repository-relative configuration contract](CONFIGURATION.md). The config
controls deterministic source selection, extractor selection, and resource
ceilings; `--tsconfig` and output flags remain invocation-level overrides.

## Revision comparison contract

`diff --base <ref> --head <ref>` resolves both refs locally and defaults to
`--comparison direct`, comparing the exact base commit tree with the exact head
commit tree. `--comparison merge-base` resolves the unique local merge base and
compares that commit with the exact head commit, matching pull-request
three-dot semantics. JSON reports record the requested refs, resolved commits,
mode, and merge-base commit when applicable; Markdown and HTML reports expose
the same context. Direct mode permits unrelated histories because it compares
two explicitly resolved trees; merge-base mode rejects them because no
pull-request comparison base exists.

Revision analysis never fetches. A merge-base comparison fails closed when the
repository is shallow, the histories are unrelated, or Git reports multiple
merge bases. A pull-request Action must use a full checkout (`fetch-depth: 0`)
and pass the event's explicit base and head refs; it must not rely on a moving
branch name or fetch implicitly. Rebases are represented by the exact head and
new merge-base SHAs in the report, so reviewers can distinguish a rewritten
head from a changed comparison base.

Diff reports are self-contained and local. HTML includes semantic headings, a
keyboard-focusable skip link, revision and schema/tool versions, per-edge
evidence, and unsupported diagnostics. JSON, Markdown, and HTML fail closed
with an actionable resource diagnostic instead of truncating when a report
contains more than 10,000 nodes, 20,000 edges, 5,000 diagnostics, or 16 MiB
of UTF-8 output.

Pass `diff --adr <path>` to compare a repository-local ADR reference index at
the exact base and head revisions. Markdown and HTML then show ADR title,
status, file, graph evidence, added/removed/changed references, and stale-link
diagnostics. This is a presentation-layer addition; JSON remains the canonical
GraphDiff v1 artifact.

`migrate-snapshot <input>` reads only legacy GraphSnapshot v0 artifacts. It
emits the migrated v1 snapshot with `--output` and writes a deterministic
identity migration report with `--report`. The report must be reviewed before
the migrated snapshot is used as a baseline.

`review-remediation <input>` evaluates a bounded human remediation review
request and emits a canonical JSON report. `--as-of` makes stale/expiry
evaluation reproducible. The command distinguishes proposed, approved,
rejected, stale, failed-validation, and applied-externally states, but never
applies a patch, merges a pull request, changes policy, or invokes a repository
command.

`policy [root] --policy <path> --snapshot <path>` or
`policy [root] --policy <path> --diff <path>` evaluates a repository-local policy
against a canonical graph artifact. Exactly one input kind is required. The
policy file must be a regular repository-relative JSON file; its bounded local
`includes` are composed deterministically before evaluation, without network or
remote resolution. The graph artifact is bounded and parsed as a snapshot or
GraphDiff. `--mode informational` is the non-blocking default when supplied;
omitting `--mode` uses the composed policy's mode. `--mode enforce` is the
explicit CI gate and still emits the canonical policy-evaluation report before
returning its findings status. `--as-of` fixes the evaluation time for local
policy exceptions, and `--exception-window-days` controls when a valid exception
is reported as expiring (the default is seven days). Active and expiring
exceptions can suppress only their matching rule violation; expired and
malformed exceptions remain visible and never suppress findings.

## Output and diagnostic streams

Successful commands write exactly one artifact to stdout when `--output` is
omitted or set to `-`; stdout is otherwise empty when an output path is used.
Warnings and failures go to stderr. A successful JSON report is a single
canonical JSON document on stdout (JSON report mode), including `diff --format json` and
`diff-snapshots --format json`; errors never emit a partial JSON artifact.

The top-level diagnostic includes a stable boundary code such as
`[cli-input]`, `[configuration-error]`, `[analysis-error]`, `[resource-limit]`,
`[cancelled]`, `[git-error]`, or `[output-error]`. Default stderr redaction
removes credentials and token assignments, bearer values, credential-bearing
URLs, JWTs, absolute POSIX/Windows paths, and source-like snippets. Each
redacted diagnostic remains actionable: relative repository paths and stable
field names remain when they are safe to show. The redaction is a log boundary
only; it does not change the canonical artifact or the library error object.

## Exit codes

- **Exit code 0** means the requested command completed successfully. `--help`,
  `--version`, a valid scan, and a valid diff use this code.
- **Exit code 1** means the request could not be completed because of invalid
  CLI input, an invalid report format, an unsafe or missing Git ref, a rejected
  path, an analysis error, or an output failure. The top-level handler writes a
  stable boundary-coded `cartograph [...]` diagnostic to stderr and does not
  report success.
- **Exit code 2** is reserved for `policy --mode enforce` when a valid report
  contains violations or unsupported rules. Informational policy checks return
  exit code 0 for the same findings; malformed policy/input and other tool
  failures use exit code 1.

The CLI does not promise a separate numeric code for each input failure. New
failure classes preserve the nonzero contract and add a human-readable
diagnostic without exposing source bodies or absolute repository paths.

## No-op scan boundary

`scan` is a static, offline operation. It parses the selected TypeScript source
and configuration but does not execute repository code, import project modules,
run package lifecycle scripts, invoke builds, call URLs, or emit telemetry. A
repository containing top-level writes or `fetch` calls remains inert during a
scan. The end-to-end assertion is in
[`test/cli/entrypoint.test.ts`](../test/cli/entrypoint.test.ts); the lower-level
security boundary is in [`test/security/offline.test.ts`](../test/security/offline.test.ts).
