# Bounded property and security regression testing

CARTOGRAPH runs an offline, deterministic property corpus from
[`test/fixtures/property-regressions/scenarios.v0.1.json`](../test/fixtures/property-regressions/scenarios.v0.1.json).
The runner is `npm run property:validate`; it uses the checked-in xorshift32
seed and does not fetch packages, execute repository source, or use a network
transport.

## Covered boundaries

The corpus runs 112 cases across four bounded suites:

- **TypeScript input:** generated valid, dynamic, and malformed source is
  analyzed twice and must serialize to the same canonical snapshot.
- **Snapshot JSON:** shuffled valid records must canonicalize idempotently;
  schema-version, cross-reference, unknown-field, and prototype-shaped input
  must reject.
- **Policy configuration:** valid node, edge, and diff rules must serialize
  idempotently; executable fields, traversal includes, malformed selectors, and
  invalid versions must reject.
- **Adapter output:** the reference adapter must produce idempotent output;
  executable input, traversal paths, unsupported API versions, and invalid
  resource limits must reject.

The checked-in regression fixtures cover source no-execution and malformed
input, snapshot prototype pollution and version drift, policy executable and
path-traversal boundaries, and adapter authority escalation and executable
configuration. A discovered crash or security defect is added to this ordered
fixture list before the corpus is expanded.

## Runtime budget

The corpus is release-gating and fails closed above 15,000 ms total or 3,000 ms
for one case. Generated TypeScript is capped at 32 KiB and four files per case.
The same command is part of `npm run check` and the CI workflow, so local pipes
exercise the security boundary even when hosted Actions are unavailable.
