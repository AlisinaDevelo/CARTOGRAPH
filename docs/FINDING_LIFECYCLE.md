# Auditable finding lifecycle

G-002 adds the local `cartograph.finding-lifecycle` v1 contract. A finding has
an explicit stable identity, policy revision, evidence revision, and initial
state. Every change is an append-only event with an actor, UTC timestamp,
rationale, evidence references, state transition, sequence, previous digest,
and canonical event digest. Reports contain no source bodies and can be
replayed without network access or repository execution.

## States and transitions

The reviewed states are `open`, `acknowledged`, `remediated`, `waived`,
`regressed`, and `obsolete`. The transition table is deliberately conservative:

| Current        | Allowed next states                                           |
| -------------- | ------------------------------------------------------------- |
| `open`         | `acknowledged`, `remediated`, `waived`, `obsolete`            |
| `acknowledged` | `open`, `remediated`, `waived`, `regressed`, `obsolete`       |
| `remediated`   | `regressed`, `obsolete`                                       |
| `waived`       | `open`, `acknowledged`, `remediated`, `regressed`, `obsolete` |
| `regressed`    | `acknowledged`, `remediated`, `waived`, `obsolete`            |
| `obsolete`     | none (terminal)                                               |

An invalid transition, sequence gap, chain mismatch, or tampered digest is
reported and is not applied. Concurrent events at one sequence are retained
in the input but deterministic replay applies the earliest timestamp and ID,
with `LIFECYCLE_CONCURRENT_EVENT` remaining visible.

## Identity, policy, and supersession

An explicit identity migration maps an old finding ID to a declared current ID;
the migration is itself digest-bound and preserves the current finding's
history. Missing targets, duplicate claims, cycles, and tampered migrations
fail closed. Events can name superseded findings; references are checked and
reported without silently deleting the older record. A finding that disappeared
from the supported architecture is explicitly transitioned to `obsolete` with
an evidence-backed rationale.

Policy and evidence revisions are carried on every event. A revision change is
not hidden: replay emits `LIFECYCLE_POLICY_CHANGED` and/or
`LIFECYCLE_EVIDENCE_CHANGED` while applying the otherwise valid transition.
Regression is represented by the explicit `remediated -> regressed` transition,
not inferred from a later scan.

The checked-in replay corpus covers all states, regression, removed architecture,
supersession, identity migration, policy and evidence revision changes,
concurrent records, deterministic serialization, and tamper rejection. Replay
it locally with:

```sh
npm run finding-lifecycle:validate
```
