# Ownership and waiver drift

G-004 adds the reviewed `cartograph.ownership-waiver-drift` v1 contract. It
compares two already-materialized, local decision states: ownership resolution,
the architecture-waiver evaluation, a safe digest-only waiver projection, the
local signing-key lifecycle, and the workspace completeness declaration.

```sh
npm run ownership-waiver-drift:validate
```

The evaluator matches ownership targets by stable key (falling back to the
target ID) so repository moves and renamed files remain reviewable. It reports
owner disappearance, explicit reassignment, ambiguous reassignment, repository
moves, partial workspaces, waiver scope/evidence/policy drift, approaching and
passed expiry, invalid or rotated signing keys, and additions/removals. Every
diagnostic carries the previous/current revision and evidence references.

The output retains the prior state's decision trail and appends current
ownership and waiver decisions. Trail records are digest-oriented and carry
`authorityGranted: false` and `autoExtended: false`; an expiring or expired
waiver is never renewed by comparison. Key projections intentionally omit
public-key bytes and all signature material. The contract is offline,
deterministic, source-body-free, and does not grant authority or write access.

The checked-in
[`scenarios.v0.1.json`](../test/fixtures/ownership-waiver-drift/scenarios.v0.1.json)
fixture covers repository moves, policy migration, evidence changes, key
rotation, owner loss, ambiguity, expiry, prior-decision retention, and partial
workspaces.
