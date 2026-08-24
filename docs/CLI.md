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
license, notice, and README. A release check installs the generated tarball in
an isolated consumer before treating the `cartograph` bin as usable.

`scan` and `diff` accept `--config <path>` for the versioned
[repository-relative configuration contract](CONFIGURATION.md). The config
controls deterministic source selection, extractor selection, and resource
ceilings; `--tsconfig` and output flags remain invocation-level overrides.

`migrate-snapshot <input>` reads only legacy GraphSnapshot v0 artifacts. It
emits the migrated v1 snapshot with `--output` and writes a deterministic
identity migration report with `--report`. The report must be reviewed before
the migrated snapshot is used as a baseline.

## Exit codes

- **Exit code 0** means the requested command completed successfully. `--help`,
  `--version`, a valid scan, and a valid diff use this code.
- **Exit code 1** means the request could not be completed because of invalid
  CLI input, an invalid report format, an unsafe or missing Git ref, a rejected
  path, an analysis error, or an output failure. The top-level handler writes a
  stable `cartograph: ...` diagnostic to stderr and does not report success.

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
