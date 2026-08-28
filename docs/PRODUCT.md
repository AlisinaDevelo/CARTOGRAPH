# Product charter

CARTOGRAPH makes architecture change reviewable. It turns supported source structures into versioned, evidence-backed graph snapshots and shows how those graphs change across revisions.

The primary question is:

> What architectural behavior did this change add, remove, or alter, and what source evidence proves it?

## Initial user

The first user is a maintainer or reviewer of a TypeScript and Express repository who wants architecture drift visibility without uploading source code or adopting a hosted service.

## Initial product loop

1. Scan a local TypeScript repository into a canonical graph snapshot.
2. Compare two snapshots or Git revisions.
3. Inspect added, removed, changed, and unresolved relationships in JSON, Markdown, or a self-contained HTML report.
4. Follow every reported relationship back to normalized source evidence.

The local loop must be useful before a GitHub Action, policy engine, runtime integration, or hosted product exists.

## Product principles

- Evidence before inference.
- Unknown is better than fabricated certainty.
- Local-first and private by default.
- Deterministic output is a release requirement.
- Schemas evolve independently from analyzer implementation.
- The graph core remains language-neutral even while the first analyzer is TypeScript-specific.
- A language model never writes canonical graph or decision state.
- Expansion follows measured adapter quality, not a language-count target.

## Analyzer and interoperability boundary

CARTOGRAPH owns the complete local architecture-change loop: the
compiler-backed TypeScript analyzer, canonical graph and diff contracts,
evidence-linked reports, policy evaluation, and bounded runtime reconciliation.
The analyzer reads only declared local repository inputs; serialized graph,
diff, policy, and report artifacts are source-free, deterministic, and suitable
for offline review. Interchange with external index formats remains additive,
strictly versioned, local, and subject to compatibility and security review.

## Supported first slice

The first implementation targets a bounded subset of:

- local TypeScript module imports;
- named functions and class methods;
- statically resolvable calls;
- direct Express route registration;
- literal outbound `fetch` and Axios destinations;
- conventional Prisma model operations.

The support matrix in the README and evaluator results define actual coverage. Dynamic registration and unresolved symbols produce diagnostics rather than confident edges.

## Success measures

The Year 1 target is:

- byte-identical normalized snapshots for identical inputs;
- evidence or an explicit unresolved reason on every edge;
- at least 0.90 precision and 0.85 recall on the declared fixture corpus;
- no network requests from local analysis or static reports;
- read-only GitHub Action execution;
- compatibility reports from at least three representative public repositories or recorded snapshots;
- no unresolved high-severity security finding at release.

## Non-goals

CARTOGRAPH does not aim to:

- prove complete architectural truth;
- replace code review, tests, architecture decisions, or observability;
- become a repository chatbot, code generator, vulnerability scanner, or general documentation wiki;
- execute repository build scripts or arbitrary plugins during analysis;
- support every TypeScript framework or language in its first release;
- require source upload, hidden telemetry, or a hosted account;
- infer architectural intent without human-declared policy or decisions.

## Open-source boundary

The analyzer, graph and diff schemas, CLI, local reports, policy engine, adapters, fixtures, evaluator, and GitHub Action belong in the Apache-2.0 repository.

Optional commercial work may eventually provide managed history, collaboration, administration, or workers, but it must never gate the complete local analysis and CI loop. The five-year public program authorizes only local-first work. Any hosted or account-based discovery requires a later ADR backed by traction, privacy, security, capacity, and funding evidence.

## Naming status

CARTOGRAPH is a working project name, not a trademark-cleared brand. The npm registry already contains unrelated `cartograph` packages, including a 2026 code-analysis package under another scope, so this repository uses the unclaimed `cartograph-cli` package name during development.
