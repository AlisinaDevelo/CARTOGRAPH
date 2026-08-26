# Explicit ownership resolution

G-001 adds a bounded `cartograph.ownership-resolution` contract for answering
“who owns this graph object?” from evidence already supplied by a caller. The
resolver is deterministic and offline: it never reads a repository, invokes a
provider, contacts GitHub, or guesses an owner from a path or package name.

## Sources and precedence

The input contains a versioned owner registry and one or more local sources.
Each source identifies its repository, repository-relative configuration path,
revision, precedence, and rules. A rule contains a portable glob, explicit
owner references, a priority, and a stable order. A result cites both the
source and winning rule with `ownership://source/...` and
`ownership://rule/...` evidence references.

For a target, only sources for the target repository are considered. Higher
source precedence wins first. Within local sources, the highest rule priority
wins; distinct owners at the same precedence and priority remain ambiguous.
For CODEOWNERS sources at the winning precedence, the last matching line wins,
matching the supported CODEOWNERS subset. A local source therefore takes
precedence over CODEOWNERS when both are present at their documented default
precedences (`200` and `100`). Callers may choose other explicit precedence
values, but the value is part of the evidence and not inferred.

Owner IDs are canonical references. Aliases such as `@platform` are resolved
only through the supplied registry. An alias that maps to more than one owner
produces `OWNERSHIP_ALIAS_CONFLICT`; an undeclared reference produces an
`unsupported` result and `OWNERSHIP_OWNER_UNKNOWN`. Unavailable owners remain
visible and produce an `unavailable` result rather than being silently
replaced. An explicit empty owner list is `unowned`.

## CODEOWNERS subset

`parseCodeowners` accepts comments, whitespace-separated owner references,
`*`, `?`, `**`, anchored paths, and trailing-directory patterns. It emits a
stable source and line-ordered rules. Negation, character classes, brace
expansion, and backslash escapes are not guessed: they are ignored with an
`OWNERSHIP_*_UNSUPPORTED` diagnostic. The parser is bounded to one MiB and
does not retain source text in the resolution report.

## Renames, repositories, and fallback

When a target has a `previousPath`, the current path is preferred. If only the
previous path matches, the result cites that path and emits
`OWNERSHIP_RENAME_FALLBACK`. If current and previous paths resolve differently,
the result is `ambiguous` with `OWNERSHIP_RENAME_CONFLICT`; both pieces of
evidence remain reviewable. Sources from another repository are never used to
resolve a target. A caller may provide an explicit fallback owner list for
otherwise unmatched targets; fallback evidence is reported separately and is
subject to the same unknown and availability checks.

The checked-in G-001 fixture covers nested patterns, CODEOWNERS last-match
behavior, unsupported negation, aliases, conflicts, renamed paths,
cross-repository objects, unknown and unavailable owners, fallback, and an
explicit no-owner outcome. Replay it with:

```sh
npm run ownership:validate
```
