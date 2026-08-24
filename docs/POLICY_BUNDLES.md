# Digest-bound policy bundles

CARTOGRAPH policy bundles are portable, local JSON contracts for sharing a
bounded set of graph rules without a hosted policy service. The checked-in
contract is [`schema/policy-bundle.v0.1.schema.json`](../schema/policy-bundle.v0.1.schema.json)
and the representative bundle is
[`schema/policy-bundle.v0.1.json`](../schema/policy-bundle.v0.1.json).

## Bundle shape

Each bundle records:

- a bundle and policy identifier, semantic policy version, and source path;
- a typed list of declarative rules (`exists`, `absent`, `count-at-most`, or
  `count-at-least`) over nodes, edges, or diffs;
- a `sha256:` digest over the canonical JSON representation of the rules;
- graph snapshot, graph diff, capability registry, and bundle compatibility
  versions;
- the owning team, creation time, and expiry time; and
- an explicit authority block whose `network`, `filesystem`, and `execution`
  values are all literal `false`.

The source path is an origin label, not an instruction to load a file. The
bundle contains no script, command, URL, module name, or arbitrary extension
field. Unknown fields are rejected.

## Offline verification

`importPolicyBundle` parses the object in memory, checks the current schema and
compatibility contract, recomputes the source digest, checks expiry, and
returns the validated bundle. It never reads the source path, opens a network
connection, executes a rule, or grants authority. A digest mismatch,
compatibility mismatch, unsupported version, expired bundle, or authority
attempt fails closed with a stable `PolicyBundleVerificationError` code.

The local gate is:

```sh
npm run policy-bundle:validate
npm run policy-bundle:validate -- --as-of 2026-08-24T00:00:00.000Z
```

The importer is intentionally a contract boundary, not a policy evaluator.
Evaluation, composition, precedence, revocation, and signed distribution are
separate roadmap work and must not be inferred from a valid bundle.
