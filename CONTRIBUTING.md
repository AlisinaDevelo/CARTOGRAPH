# Contributing

CARTOGRAPH is an early, TypeScript-first open-source project for evidence-backed architecture change control. The initial scope is a deterministic local workflow: inspect a repository, compare architecture snapshots, and keep every reported relationship tied to evidence.

Please read the product and architecture documents in [`docs/`](docs/) before proposing a broad change. The project is intentionally narrower than a general repository chatbot, security scanner, or universal language analyzer.

## Development setup

Use Node.js 22 or 24 (Node.js 22 must be at least 22.13.0) and npm.

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

`npm run check` runs formatting, linting, type-checking, tests, and the build. Run individual commands while iterating when that gives faster feedback:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Do not run the analyzer against repositories containing secrets or data you are not authorized to process. Keep fixtures small, synthetic where possible, and free of credentials or proprietary source.

## Making a change

1. Search existing issues before opening a new one.
2. For a substantial change, open an issue describing the problem, intended outcome, and evidence that would show it works.
3. Keep changes focused and preserve deterministic output, portable evidence locations, and the local-only trust boundary.
4. Add or update tests and fixtures for behavior that can regress.
5. Update the relevant documentation when a contract, supported construct, security boundary, or user-facing command changes.
6. Open a pull request with the provided template and report the validation commands you actually ran.

The analyzer may encounter untrusted paths, source code, Git history, package metadata, and output paths. Changes that execute repository code, use shell interpolation for repository-controlled values, write outside an explicitly validated output directory, or add network access need a documented security review before they are considered.

## Contributions and licensing

By contributing, you agree that your contribution is provided under the Apache-2.0 license used by this repository. Please keep public discussion factual and avoid including private source, credentials, personal data, or unpublished vulnerability details.

## Security reports

Do not report vulnerabilities in a public issue. Follow [`SECURITY.md`](SECURITY.md) for GitHub private vulnerability reporting and the maintainer fallback.
