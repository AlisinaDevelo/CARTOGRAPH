# Adapter starter independent dry run

This is the recorded independent-harness review required by E-009. It is not a
claim that an outside organization reviewed CARTOGRAPH. Independence here means
the harness is a separate executable from the starter adapter and evaluates it
only through the public adapter contract, published fixture schema, package
metadata, compatibility negotiation, and security parsers.

## Review record

- Adapter: `cartograph.starter.example@0.1.0`
- Harness: `scripts/adapter-starter.mjs`
- Fixture: `examples/adapter-starter/fixtures/cases.v0.1.json`
- Review date: 2026-08-25
- Required command: `npm run adapter-starter:validate`
- Hosted Actions/Copilot: not used; the command is offline and local
- Fixture digest: `sha256:ff5fffa867ec2723f7988c76b73f303bd4b28b971dbf419382f88c1de136cdfa`

The harness checks the package dry-run, three fixture cases (`empty`,
`supported`, and `unsupported`), repeated canonical output, evidence
completeness, declared unsupported diagnostics, current compatibility,
rejection of a future capability-registry version, unsafe authority/config/path
inputs, and the isolated host when the runtime can enforce network denial.

The local Node 26.7.0 run passed with three deterministic, evidence-complete
cases, current compatibility `compatible`, future compatibility `rejected`,
all three security booleans false, and isolated execution available.

The fixture digest and result are emitted by the command and copied into the
task evidence after the merged-main verification. A runtime that cannot enforce
the permission model records `unsupported-runtime`; it is never treated as a
successful unisolated execution.
