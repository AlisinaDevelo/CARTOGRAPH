# Local ADR references

CARTOGRAPH's ADR reference contract is a small, versioned JSON index. It keeps
decision records local and reviewable while making the file, title, status, and
graph identities explicit:

```json
{
  "schemaVersion": 1,
  "references": [
    {
      "id": "ADR-0001",
      "file": "docs/adr/0001-typescript-first-semantic-adapter.md",
      "title": "Start with a TypeScript 6 semantic adapter",
      "status": "accepted",
      "graphIds": ["module:src/analyzers/typescript.ts"]
    }
  ]
}
```

The published JSON Schema is
[`schema/adr-reference.v0.1.schema.json`](../schema/adr-reference.v0.1.schema.json),
and a complete example is in
[`schema/adr-reference.v0.1.json`](../schema/adr-reference.v0.1.json). Statuses
are deliberately bounded (`draft`, `proposed`, `accepted`, `rejected`,
`deprecated`, and `superseded`). The additive lifecycle fields model the
meaning of a status over time:

- `statusHistory` is an ordered list of `{status, effectiveAt}` entries. The
  final entry must match `status`, timestamps must increase strictly, and each
  status change must use one of these transitions:
  `draft -> proposed|rejected`, `proposed -> draft|accepted|rejected`,
  `accepted -> deprecated|superseded`, `rejected -> proposed|deprecated`, and
  `deprecated -> superseded`. `superseded` is terminal.
- `effectiveFrom` and `effectiveTo` bound the decision's effective period; when
  both are present, the start must precede the end.
- `supersedes` points from the newer ADR to the older ADR IDs it replaces. Each
  target must exist and be marked `superseded`; every `superseded` ADR must have
  an incoming link. Chains are valid, while cycles, missing targets, status
  mismatches, and missing incoming links produce deterministic diagnostics.

The parser fails closed for unknown statuses and unknown fields, so an
unrecognized lifecycle convention cannot silently change architectural meaning.
The lifecycle fixture corpus is validated by
`npm run adr-lifecycle:validate` and covers valid chains, cycles, missing
targets, status changes, date errors, and unknown conventions.

The runtime parser and `readAdrReferenceDocument` accept only a repository-local
regular JSON file. `validateAdrReferences` can then check each referenced ADR
Markdown file for a matching first-level title and `- Status:` line, and can
check graph node IDs/stable keys or edge IDs (`edge:<from>|<kind>|<to>`) against
a supplied local snapshot. It reports missing files, malformed files or graph
IDs, stale file metadata, stale graph IDs, and required graph IDs with no ADR
reference. Diagnostics are deterministic and the complete path performs no
network access, account lookup, hosting-service call, or code execution.

The contract records traceability, not architectural truth: an ADR link does
not prove that the decision is correct or that the implementation follows its
intent.

Policies can require selected boundaries and expiry-bound exceptions to carry
these references through the additive
[`policy ADR binding contract`](POLICY_ADR_BINDINGS.md). Binding evaluation
remains local and evidence-backed; it does not infer approval or fetch a
decision from a hosting service.
