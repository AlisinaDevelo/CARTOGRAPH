# Remediation assistance evaluation gate

S-006 is an offline, repository-authored evaluation of governed remediation
assistance. It measures quality and reviewer reality without contacting a
provider, executing a suggestion, modifying a policy, or treating synthetic
fixtures as evidence that an external model is safe.

The checked-in fixture set covers these suggestion classes: explanation,
investigation step, configuration change, policy action, waiver action,
documentation action, and code-change suggestion. Each case records:

- applicability, emission, unsafe content, and validation outcome;
- stale-evidence presence and whether the gate detected it;
- reviewer acceptance, override, rejection, or lack of review;
- baseline and assisted time, reproducibility, and estimated cost;
- provider-data exposure (`none`, `digest-only`, `redacted-summary`, or
  forbidden `raw`) plus explicit consent; and
- network use and automatic application, both of which must remain false in
  this offline evaluation.

The evaluator reports applicability precision, unsafe suggestion rate,
validation success, stale-evidence detection, reviewer acceptance and override,
time saved or added, reproducibility, cost, and provider exposure overall and
by suggestion class. Red-team cases cover injection, secret leakage, destructive
commands, policy weakening, broad waivers, dependency confusion, fabricated
evidence, compromised providers, and automation bias.

The current gate is deliberately `rule-only`: safety and deterministic quality
metrics pass, but reviewer acceptance is below the graduation threshold. The
matrix contains all nine declared red-team threats: unsafe threats are
suppressed and automation bias is overridden by the reviewer. The result does
not authorize a provider, automatic application, policy weakening,
or merge automation. A later evaluation must improve reviewer acceptance and
repeat the complete adversarial matrix before considering `graduate`.

Run the deterministic validator locally:

```sh
npm run remediation-evaluation:validate
```

The report and fixture digests are stable under scenario ordering. The fixture
validator uses inert markers and no network or command execution.
