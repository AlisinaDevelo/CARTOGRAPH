# Human remediation review workflow

The `cartograph.remediation-review` v0.1 contract is the accountability record
around a governed remediation suggestion. It is deliberately separate from
suggestion generation and isolated patch preview. A review records the
suggestion version and digest, owner, reviewer, source/evidence revision,
decision, rationale, validation result, expiry, and final disposition.

The lifecycle state is deterministic at a caller-supplied evaluation time:

| State                | Meaning                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `proposed`           | The owner has a bounded suggestion awaiting a decision.                                                                   |
| `approved`           | A named reviewer approved it while evidence is current and validation passed.                                             |
| `rejected`           | A named reviewer rejected it with a rationale.                                                                            |
| `stale`              | The review expired before a final external disposition.                                                                   |
| `failed-validation`  | Validation failed; approval cannot be treated as valid.                                                                   |
| `applied-externally` | A previously approved and validated result was applied outside CARTOGRAPH with an external reference and evidence digest. |

The review report always carries `readOnly: true`, all authority flags false,
`autoApply: false`, `policyMutation: false`, and `mergeAutomation: false`.
CARTOGRAPH never merges a pull request, edits a worktree, changes a policy, or
marks a suggestion applied. `applied-externally` is an attestation supplied by
the user or an external system, not an action performed by CARTOGRAPH.

Approved or rejected states require a reviewer and review timestamp. An
`approved` report state requires a passed validation result; an approved
decision whose validation fails is reported as `failed-validation` instead.
Every record has an expiry, and stale evidence is visible rather than silently
re-approved. The review digest binds the complete request, including the
suggestion and evidence digests, so a changed suggestion requires a new review.

The local CLI evaluates a request without side effects:

```sh
cartograph review-remediation review.json --as-of 2030-01-01T00:00:00.000Z
```

It emits a canonical JSON report whose `state`, `decision`, `validation`, and
`finalDisposition` are machine-readable. The command reads one bounded input
file and does not invoke Git, a provider, a command from the repository, or a
network service.

The checked-in lifecycle, invalid-review, authority, and serialization cases
are validated offline with:

```sh
npm run remediation-review:validate
```

The existing CI workflows remain `pull_request`-based with least-privilege
permissions and no `pull_request_target`; a future read-only review job must
retain that fork-safe boundary and may only publish a report artifact.
