# Landscape and technical research

Research date: 2026-08-23. Product status and links are date-sensitive; re-check them before positioning or partnership decisions.

## Finding

Architecture maps, dependency graphs, repository context, and architectural rules are established categories. CARTOGRAPH is only differentiated if the primary artifact is a reproducible, compiler-backed architecture diff with evidence and explicit uncertainty.

It should not compete as a generic visualization, repository chatbot, security scanner, or code-search platform.

## Adjacent tools

| Tool                                                                                                                                  | Relevant capability                                                       | Consequence for CARTOGRAPH                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [CodeScene](https://codescene.io/docs/guides/architectural/architectural-analyses.html)                                               | Architecture analysis, change coupling, code health, and PR quality gates | Stay narrow: compiler-resolved structural changes and evidence, not broad behavioral analytics.                    |
| [Sourcegraph precise code navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation)                           | Compiler/indexer-backed code intelligence through SCIP                    | Keep local operation independent; consider SCIP interchange later.                                                 |
| [Unblocked](https://unblocked.mintlify.app/what-is-unblocked)                                                                         | AI context across source, discussions, documents, and review              | Keep canonical graph and policy state deterministic; AI may explain evidence later.                                |
| [Backstage catalog](https://backstage.io/docs/features/software-catalog/system-model/)                                                | Human-curated systems, components, APIs, resources, and ownership         | Treat catalog data as optional organizational metadata, not source-level truth.                                    |
| [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) and [Madge](https://github.com/pahen/madge)                      | JavaScript and TypeScript dependency graphs, cycles, and rules            | Do not stop at a dependency graph. Temporal identity, semantic diffs, evidence, and change control must be real.   |
| [Nx project graph](https://nx.dev/docs/features/explore-graph)                                                                        | Workspace-aware project and affected graphs                               | Add an adapter only after core semantics work outside Nx.                                                          |
| [CodeQL](https://codeql.github.com/docs/codeql-overview/about-codeql/) and [Semgrep](https://semgrep.dev/docs/writing-rules/glossary) | Static analysis, data flow, security results, and cross-file analysis     | Interoperate through bounded formats such as SARIF; do not rebuild security analysis or bundle restricted engines. |
| [Joern](https://docs.joern.io/code-property-graph/)                                                                                   | Multi-language code property graphs                                       | A broad CPG is heavier than the TypeScript-first review loop requires.                                             |

[CodeSee](https://gitkraken.com/press/gitkraken-acquires-codesee-launches-devex-platform) is a historical map and PR-review predecessor acquired by GitKraken in 2024; its original Marketplace map action is archived. [Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail) is archived. Both reinforce that visualization alone is not a durable wedge.

## Technical decisions

The first analyzer uses TypeScript's semantic program model through ts-morph rather than syntax-only matching. It must honor the active module-resolution mode and expose unresolved cases. Relevant primary references include the [TypeScript Compiler API guide](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference), and [project references](https://www.typescriptlang.org/docs/handbook/project-references).

TypeScript 7.0 is a native port and does not provide the TypeScript 6 compiler API. The [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) identifies `@typescript/typescript6` as the compatibility path and anticipates a new API later. CARTOGRAPH therefore pins the TS6-era adapter, isolates it behind a contract, and tracks transition work explicitly.

Git diffs must record the exact revisions and merge-base semantics described in the [Git diff documentation](https://git-scm.com/docs/git-diff). A future Action uses the [Checks API](https://docs.github.com/en/rest/checks/runs) only as a presentation surface; canonical graph JSON remains portable. SARIF may represent line-local policy findings, but the [GitHub SARIF subset](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support) is not the graph transport.

## Principal risks

- TypeScript 7 API transition.
- Module-resolution and monorepo complexity.
- Noisy identity across moves and renames.
- False certainty around dynamic JavaScript and framework conventions.
- Review overload from raw graphs.
- GitHub Action supply-chain and fork security.
- Naming confusion with existing `cartograph` projects.
- Duplicating dependency-graph tools without delivering temporal change control.

## Outreach thesis

The first useful outreach object is not a pitch or waitlist. It is a reproducible architecture-diff report for a public TypeScript repository, with direct evidence and a candid limitations section. Maintainers can then judge whether the same result would help on a private repository without sending code away.
