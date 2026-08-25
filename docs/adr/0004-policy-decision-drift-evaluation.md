# ADR 0004: Proceed with the local policy and decision drift gate

- Status: accepted
- Date: 2028-04-30
- Decision: proceed

## Context

ADR traceability is only useful when change scenarios expose stale decisions,
removed architecture, policy changes, missing references, exception behavior,
and schema boundaries with evidence a reviewer can inspect. A passing parser or
single golden example does not establish that the combined policy/decision loop
is reviewable.

## Decision

Accept the P-018 local exit gate for the curated v0.1 corpus. The six scenario
families are evaluated offline against the versioned graph diff, policy, and
ADR contracts. The report requires complete expected-finding recall, no
unexpected findings, bounded reviewer effort, explicit evidence review, and a
categorized record of reviewer overrides. Mixed schema input remains a visible
fail-closed finding and does not get silently migrated.

The observed corpus records six expected and six observed findings, zero
missing or unexpected findings, 39 reviewer minutes, and two categorized
overrides. This authorizes continued local ADR/policy traceability work; it
does not authorize hosted analysis, source upload, automatic policy mutation,
or a claim of universal drift-detection recall.

## Consequences

Future contract changes must update the versioned scenario fixture, expected
finding set, reviewer effort record, and report digest together. A missed
finding, uncategorized reviewer override, or schema-boundary regression holds
the milestone exit until reviewed.
