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
`deprecated`, and `superseded`); lifecycle transitions and supersession
semantics are a later contract.

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
