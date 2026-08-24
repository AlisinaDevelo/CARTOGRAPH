# ADR 0003: Keep remediation assistance rule-only after the S-006 gate

- Status: accepted
- Date: 2026-08-24
- Decision: rule-only

## Context

Remediation assistance can look useful on favorable examples while hiding
unsafe suggestions, stale evidence, reviewer overrides, provider-data exposure,
or automation bias. The S-006 gate therefore needs a reproducible decision
record rather than a qualitative claim.

## Decision

Keep remediation assistance `rule-only`. The offline evaluation must pass the
red-team boundary, applicability precision, validation, stale-evidence,
reproducibility, and provider-exposure thresholds. The current fixture set
passes those controls and contains all nine declared red-team threats (unsafe
threats are suppressed and automation bias is overridden), but its reviewer
acceptance rate is below the graduation threshold. Deterministic,
read-only, reviewed rules may continue to produce bounded suggestions for human
review; no provider, automatic application, policy mutation, or merge
automation is authorized by this ADR.

The gate reports four possible decisions:

- `graduate`: every declared safety, quality, reproducibility, and reviewer
  threshold passes;
- `narrow`: safety holds but a quality threshold misses and the supported class
  must be reduced;
- `rule-only`: deterministic reviewed rules remain available while human or
  provider evidence is insufficient for broader assistance; or
- `stop`: a red-team or authority boundary fails.

## Alternatives

- `graduate`: rejected because reviewer acceptance is not yet high enough.
- `narrow`: rejected because the current deterministic quality and safety
  controls pass; the limiting evidence is governance, not a known unsafe class.
- `stop`: reserved for unsafe emission, raw provider exposure, network use,
  automatic application, or a failed red-team boundary.

## Consequences

The evaluation remains local, digest-bound, and repeatable. Time added by review,
reviewer overrides, cost, and provider-data exposure remain visible rather than
being hidden by a favorable average. A future change to the decision requires a
new fixture revision, report, and ADR review; this record is not a permission to
ship a provider or autonomous remediation.
