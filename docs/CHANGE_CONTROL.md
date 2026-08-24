# Deprecation and change-control register

Long-lived compatibility surfaces are tracked in
[`schema/change-control.v0.1.json`](../schema/change-control.v0.1.json), whose
shape is defined by
[`schema/change-control.v0.1.schema.json`](../schema/change-control.v0.1.schema.json).
The register covers schemas, CLI flags, adapter capabilities, and policy
features. Every entry has an owner, a review date, and an explicit status.

## Status and removal rules

`active` entries have no replacement or removal gate. A `deprecated` entry must
name its replacement, explain the deprecation, and provide a migration note,
fixture update, and validation command. A `removed` entry is a retained tombstone
with the same gate metadata; entries must not simply disappear from the register.
The validator checks that every referenced migration note and fixture is a
repository file.

Run the release gate locally with:

```sh
npm run change-control:validate
npm run change-control:validate -- --as-of 2026-08-24
```

The command reports overdue reviews and exits non-zero when any active or
deprecated entry is past its review date. In a pull request, pass `--base-ref`
to compare the register with the base revision. Deleting an entry then requires
both a migration note under `schema/migrations/` (or the identity migration
record) and a changed fixture under `test/fixtures/`.

Changes to a deprecated surface must update the register, the replacement or
migration documentation, and the relevant fixture in one review. The register
is a tombstone-bearing history, not a list to prune for tidiness.
