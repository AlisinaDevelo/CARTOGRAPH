# Support matrix

Owner: `CARTOGRAPH maintainers`

Review cadence: at least once per quarter and before every minor release; review immediately when a security boundary, parser dependency, or supported-construct claim changes.

## Adapter selection boundary

Adapter and language expansion decisions are governed by the public
[adapter selection RFC](ADAPTER_SELECTION.md) and its machine-readable
[support matrix](../schema/adapter-support-matrix.v0.1.json). The current
matrix is `cartograph-adapter-support-v0.1` with digest
`sha256:43a88a895f18053aa7a44369bd97bd2987cd0b94bebee61e388cc34f1354530f`.
Run `npm run adapter:support:validate` to check schema conformance, status
coverage, shipped manifests, repository references, and documentation.

| Status         | Current entries                           | Support boundary                                                        |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `implemented`  | `cartograph.sample`, `cartograph.fastify` | Named bounded capabilities and fixtures only.                           |
| `experimental` | `cartograph.starter.example`              | Contributor preview; no stable support promise.                         |
| `deferred`     | `language.rust`                           | Candidate recorded for a future bounded pilot; no implementation claim. |
| `unsupported`  | `language.python`                         | Outside the current adapter boundary; no graph is inferred.             |

The matrix names a primary owner, backup, review cadence, compatibility
dimensions, and retirement triggers for every promoted entry. A language or
framework is never promoted because a parser produced a plausible graph: it
must pass the criteria, security boundary, evidence, and compatibility gates
in the RFC.

## Runtime and toolchain boundary

The machine-readable declaration is
[`schema/support-matrix.v0.1.json`](../schema/support-matrix.v0.1.json), checked
by `npm run support:validate` against `package.json`, `package-lock.json`, and
the CI workflow. The declared Node.js LTS window is 22.x and 24.x, with a
minimum of Node 22.13.0. CI covers `ubuntu-latest` and `macos-latest`; Linux
and macOS are the supported operating systems. The pinned analysis toolchain
is TypeScript 6.0.3 with ts-morph 28.0.0. Local runs on a newer compatible
Node (such as Node 26) are useful compatibility evidence but do not expand the
declared LTS window.

The CLI checks this boundary before parsing commands. An unsupported operating
system or Node version fails closed with the stable
`SUPPORT_MATRIX_UNSUPPORTED_ENVIRONMENT` diagnostic instead of producing
architecture evidence under an unreviewed runtime. The matrix validator also
requires the CI workflow to keep the declared OS and Node entries in sync.

This matrix is the public boundary of the first analyzer. A construct is supported only when the evaluator has a positive fixture, a negative or ambiguity fixture where relevant, complete evidence coverage, and a documented result. A plausible graph outside this table is not a support claim.

## Supported constructs

| Construct                                                                               | Status    | Evidence source                                          | Unknown or excluded behavior                                                                                                     |
| --------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript `.ts`, `.tsx`, `.mts`, and `.cts` files                                      | Supported | TypeScript compiler program and normalized source spans  | JavaScript files and declaration files are excluded; generated and dependency directories are excluded                           |
| Local and external imports, re-exports, literal dynamic imports, and literal `require`  | Supported | Import or export syntax at the source location           | Non-literal module expressions produce an unresolved diagnostic rather than a guessed edge                                       |
| Node16/NodeNext package `exports` and `imports` maps                                    | Supported | TypeScript resolver outcome plus package-map source span | `import`/`require`/`node`/`types` branches are deterministic; additional environment branches emit `AMBIGUOUS_PACKAGE_CONDITION` |
| Named functions, class methods, and variable-bound arrow functions                      | Supported | Declaration and symbol spans from the TypeScript program | Anonymous or dynamically-created call targets remain unresolved                                                                  |
| Statically resolvable calls                                                             | Supported | TypeScript symbol resolution at the call site            | Dynamic dispatch and unresolved symbols do not become confident call edges                                                       |
| Direct Express `app` or `router` routes and bounded `use` middleware with literal paths | Supported | Express registration call and handler source spans       | Dynamic route registration, computed paths, and framework metaprogramming produce diagnostics                                    |
| Literal `fetch` and Axios destinations                                                  | Supported | Literal URL argument and request call span               | Computed or runtime-only destinations remain unresolved                                                                          |
| Conventional Prisma model reads and writes                                              | Supported | Prisma model operation and source span                   | Dynamic model names and unsupported client wrappers remain unresolved                                                            |

The X-002 golden fixture covers named re-exports, star re-exports, literal
dynamic `import()`, literal `require()`, and non-literal dynamic module
expressions. Every emitted module edge carries source evidence; non-literal
expressions remain explicit `UNSUPPORTED_DYNAMIC_IMPORT` diagnostics.

The X-003 golden fixture covers direct `app` and `router` route methods,
`route(...).get(...)` chains, literal-prefix `use` middleware, and statically
bound global middleware. Middleware registrations are represented as `USE`
endpoint nodes with handler call edges and source evidence; computed mount paths
remain explicit `UNSUPPORTED_DYNAMIC_ROUTE` diagnostics.

The X-004 diagnostic registry gives every supported unknown case a unique code,
warning severity, source-span evidence contract, and actionable remediation.
Analyzer diagnostics are resolved through that registry before they enter a
snapshot; reports carry the remediation alongside the diagnostic message.

## Unsupported or unresolved

The analyzer does not claim complete runtime behavior, JavaScript support, generated routes, framework metaprogramming, arbitrary plugins, or universal language/framework coverage. Dynamic routes, imports, HTTP destinations, model names, handlers, and calls are represented as stable diagnostics when they cannot be resolved safely.

Unsupported input must not be silently promoted to a certain architectural edge. The correct result is an explicit diagnostic, an inferred edge with evidence where the bounded resolver permits it, or no edge with an unresolved reason.

## Review process

1. A maintainer opens a focused issue or RFC describing the proposed support change, its security and compatibility impact, and the evidence needed to evaluate it.
2. The change adds or updates representative positive, negative, and ambiguity fixtures before changing the support claim.
3. The evaluator records precision, recall, path accuracy where applicable, unresolved diagnostics, and evidence completeness. The declared release target is at least 0.90 precision, 0.85 recall, and 100% evidence or an explicit unresolved reason for emitted edges.
4. The pull request runs the full local check, reviews the support-matrix diff, and records the exact device, OS, architecture, Node.js/npm/TypeScript toolchain, commit, and artifact digests in its evidence.
5. The maintainer reviews and merges the change to protected `main`. The same reproduction is rerun against the merged SHA before the related issue is closed.

The authoritative evaluator and measurement definitions are in [`docs/EVALUATION.md`](EVALUATION.md). The product boundary and non-goals are in [`docs/PRODUCT.md`](PRODUCT.md).
