# Policy and decision drift evaluation

CARTOGRAPH's P-018 gate is an offline, curated comparison of policy and ADR
evidence across change scenarios. The validator is
`npm run policy-drift:validate`; it reads the checked-in fixture, invokes the
local diff, policy, and ADR contracts, and never fetches a repository, executes
source, or sends graph data to a service.

## Scenario coverage

The v0.1 corpus contains six deliberately small scenarios:

- decision supersession, where a live policy binding still names an older ADR;
- removed architecture, where a removed graph object leaves stale ADR and
  policy evidence;
- policy change, where a tightened rule changes a passing graph into a
  violation;
- unreferenced addition, where a new graph identity has no ADR coverage;
- an active ADR-backed exception that suppresses a policy violation; and
- mixed schema versions, which must fail closed before comparison.

Each case publishes the expected finding, observed finding, evidence references,
reviewer disposition, review steps, and minutes. The report also groups
reviewer overrides into false-positive categories instead of hiding them in an
aggregate score.

## Milestone exit decision

The checked-in P-018 evaluation records a `proceed` decision for the Year 2 Q3
ADR traceability gate. Finding recall is 1.0 with no unexpected findings;
reviewer effort is 39 minutes across six cases, and the two overridden cases
are categorized as `policy-noise` and `intentional-internal-addition`. This is
an exit decision for the curated local evidence, not a claim that all policy or
ADR drift in arbitrary repositories is solved.

The decision is recorded in [ADR 0004](adr/0004-policy-decision-drift-evaluation.md)
and is reproducible from the fixture digest emitted by the validator.
