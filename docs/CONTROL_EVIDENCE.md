# Tracing controls to evidence

> **Not a certification.** A control evidence report shows which mapped
> evidence a verified bundle contains and which is missing, stale, or
> contradicted. It is not an audit opinion and does not attest compliance
> with any standard or regulation. It does not show that a control is
> designed or operating effectively. These limitations are printed at the top
> of every report and cannot be turned off.

```sh
cartograph controls evaluate --mapping controls.json --bundle bundle/ \
  --as-of 2030-06-01T00:00:00Z
```

## The mapping

A control mapping (`cartograph.control-mapping` v1,
[schema](../schema/control-mapping.v0.1.schema.json)) is a local file the
control owner writes. Each control has:

- `id`, `title`, `objective`, and `owner`
- `scope`: a description and optional path patterns
- `period`: `from` and `to` (the control is `out-of-period` outside it)
- `applicability`: `full`, `partial`, or `not-applicable`, with a required
  `applicabilityNote` for the last two
- `evidence`: one or more items

| Evidence type     | Fields                                  | Source                                               |
| ----------------- | --------------------------------------- | ---------------------------------------------------- |
| `policy-rule`     | `policyId`, `ruleId`                    | the bundled policy and its evaluation                |
| `decision`        | `decisionId`                            | the bundled ADR references                           |
| `waiver`          | `waiverId`                              | the bundled waivers                                  |
| `finding`         | `findingId`, optional `expectedStates`  | the bundled finding lifecycle, replayed to `--as-of` |
| `bundle-artifact` | `role`                                  | the bundle manifest                                  |
| `test`            | `name`, `result`, `ranAt`, `reportedBy` | supplied by the owner                                |
| `owner-assertion` | `owner`, `statement`, `assertedAt`      | supplied by the owner                                |

## The report

Every evidence item lands in exactly one list (`cartograph.control-evidence`
v1, [schema](../schema/control-evidence.v0.1.schema.json)):

- **observed:** CARTOGRAPH found it in the verified bundle. Examples: a rule
  evaluated with no violations, an accepted and still-effective decision, an
  unexpired waiver, or a finding in an expected state.
- **asserted:** a passing test or an owner statement within the control
  period, reported as supplied, with who and when. CARTOGRAPH does not verify
  it.
- **gaps:** `missing` (not in the bundle), `declared-missing` (the bundle
  says why), `not-evaluated` (the policy has no bundled evaluation),
  `unsupported-rule`, `decision-not-accepted`, or `stale` (a superseded,
  deprecated, or expired decision, an expired waiver, or a test or assertion
  outside the period).
- **conflicts:** `rule-violated`, `decision-rejected`, `finding-state` (not
  in an expected state), or `test-failed`.

A control's status is `not-applicable`, `out-of-period`, `conflicting` (any
conflict), `gaps` (any gap), `asserted-only` (nothing observed), or
`supported` (everything observed or asserted, with at least one item
observed). `partial` applicability keeps its note in the report, and a
`supported` partial control covers only what the note says.

The command refuses a bundle that does not verify. Verify the bundle's
signature separately (`cartograph bundle verify --signature`) if its origin
matters.
