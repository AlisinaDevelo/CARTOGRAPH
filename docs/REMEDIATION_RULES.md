# Deterministic remediation rules

The reviewed `cartograph.remediation-rules` v0.1 catalog provides six fixed,
read-only rules over the governed suggestion contract:

- unknown-edge policy review
- missing configuration-boundary review
- missing decision-reference documentation
- missing-owner investigation
- expired-exception waiver review
- unresolved-dependency investigation

Each entry declares its supported finding code, applicability summary,
preconditions, non-goals, validation-command descriptions, risk, and golden
positive/negative fixture IDs. Validation-command fields are documentation;
the catalog never executes commands, edits files, fetches repositories, or
selects a provider.

`generateDeterministicRemediationSuggestions` sorts findings and reviewed rules
before delegating to the S-001 read-only generator. Its serialized output and
catalog digest are byte-stable, while stale baseline or evidence, ambiguity,
missing ownership, security sensitivity, unsupported findings, and resource
limits remain explicit skips.

Validate the catalog and golden fixtures with:

```sh
npm run remediation-rules:validate
```

This catalog is intentionally bounded. New finding classes require a reviewed
catalog and fixture change rather than implicit fallback guidance.
