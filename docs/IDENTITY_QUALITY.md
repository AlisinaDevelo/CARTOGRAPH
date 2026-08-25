# Identity quality gate

P-013 turns the identity corpus into a release gate. The validator is
`npm run identity:quality:validate`; it replays the deterministic curated and
seeded generated cases, computes rates by refactor family, and compares the
whole quality object with the checked-in digest in
[`quality-baseline.v0.1.json`](../test/fixtures/identity-corpus/quality-baseline.v0.1.json).

## Baseline

The current baseline uses seed `12648430`, seven curated regressions, and 56
generated cases. Preservation, false-match, ambiguity, and unmatched rates are
reported separately for the curated and generated partitions and for each
family: line move, file move, supported rename, duplicate names, overloads,
path alias, and ambiguous transformation.

| Partition | Cases | Preservation | False-match | Ambiguity | Unmatched | Unsupported |
| --------- | ----: | -----------: | ----------: | --------: | --------: | ----------: |
| Curated   |     7 |       1.0000 |      0.0000 |    0.3077 |    0.0000 |      0.0000 |
| Generated |    56 |       1.0000 |      0.0000 |    0.3333 |    0.0000 |      0.0000 |

Ambiguity is not treated as a failure: duplicate-name and ambiguous families
must remain conservative. False matches, unmatched eligible identities, and
unsupported results are release failures. The exact quality digest also makes
unexpected changes to family counts or rates fail closed.

## Thresholds and exceptions

The v0.1 thresholds require preservation `>= 1.0`, false-match `<= 0`,
unmatched `<= 0`, and unsupported `<= 0` for both partitions. A threshold or
baseline change requires a reviewed issue that records the affected family,
before/after rates, fixture or generator change, owner, rationale, and a
reproduction command. An exception must expire within 90 days and cannot be
activated without all of `issue`, `owner`, `rationale`, and `expiresAt`; the
validator rejects an unreviewed active exception. The release record must link
the issue and rerun the gate against the merged commit.
