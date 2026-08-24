# Governed remediation suggestions

The v0.1 `cartograph.remediation-suggestion` contract describes bounded,
inspectable ideas without changing graph, policy, history, or finding truth.
Every suggestion is explicitly `unverified`, read-only, and authority-free:
the record contains no network, filesystem, or execution capability.

The contract distinguishes these suggestion kinds:

- explanation
- investigation step
- configuration change
- policy action
- waiver action
- documentation action
- code-change suggestion

Each record carries the finding ID and digest, baseline and evidence digests,
input references, evidence references, confidence, assumptions, risk,
reversible proposed edits, and a validation plan. Values are represented by
digests or bounded references; the contract does not execute commands or apply
edits.

`generateRemediationSuggestions` is opt-in. Its default mode is disabled and
returns no suggestions. Enabled generation requires an explicit current
baseline digest and per-finding evidence digests, a reviewed rule set, and a
bounded suggestion count. It emits explicit skip reasons for unsupported,
stale, ambiguous, ownerless, security-sensitive, invalid, or over-budget
findings. Unsupported findings never receive fabricated remediation text.

Validate the checked-in scenarios with:

```sh
npm run remediation-suggestions:validate
```

This contract is a proposal surface only. Deterministic rule authoring,
isolated patch preview, provider boundaries, approval, and red-team evaluation
remain separate roadmap controls.
