# Support matrix

Owner: `CARTOGRAPH maintainers`

Review cadence: at least once per quarter and before every minor release; review immediately when a security boundary, parser dependency, or supported-construct claim changes.

This matrix is the public boundary of the first analyzer. A construct is supported only when the evaluator has a positive fixture, a negative or ambiguity fixture where relevant, complete evidence coverage, and a documented result. A plausible graph outside this table is not a support claim.

## Supported constructs

| Construct                                                                               | Status    | Evidence source                                          | Unknown or excluded behavior                                                                           |
| --------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| TypeScript `.ts`, `.tsx`, `.mts`, and `.cts` files                                      | Supported | TypeScript compiler program and normalized source spans  | JavaScript files and declaration files are excluded; generated and dependency directories are excluded |
| Local and external imports, re-exports, literal dynamic imports, and literal `require`  | Supported | Import or export syntax at the source location           | Non-literal module expressions produce an unresolved diagnostic rather than a guessed edge             |
| Named functions, class methods, and variable-bound arrow functions                      | Supported | Declaration and symbol spans from the TypeScript program | Anonymous or dynamically-created call targets remain unresolved                                        |
| Statically resolvable calls                                                             | Supported | TypeScript symbol resolution at the call site            | Dynamic dispatch and unresolved symbols do not become confident call edges                             |
| Direct Express `app` or `router` routes and bounded `use` middleware with literal paths | Supported | Express registration call and handler source spans       | Dynamic route registration, computed paths, and framework metaprogramming produce diagnostics          |
| Literal `fetch` and Axios destinations                                                  | Supported | Literal URL argument and request call span               | Computed or runtime-only destinations remain unresolved                                                |
| Conventional Prisma model reads and writes                                              | Supported | Prisma model operation and source span                   | Dynamic model names and unsupported client wrappers remain unresolved                                  |

The X-002 golden fixture covers named re-exports, star re-exports, literal
dynamic `import()`, literal `require()`, and non-literal dynamic module
expressions. Every emitted module edge carries source evidence; non-literal
expressions remain explicit `UNSUPPORTED_DYNAMIC_IMPORT` diagnostics.

The X-003 golden fixture covers direct `app` and `router` route methods,
`route(...).get(...)` chains, literal-prefix `use` middleware, and statically
bound global middleware. Middleware registrations are represented as `USE`
endpoint nodes with handler call edges and source evidence; computed mount paths
remain explicit `UNSUPPORTED_DYNAMIC_ROUTE` diagnostics.

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
