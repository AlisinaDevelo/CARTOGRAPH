# Fixture provenance

Checked-in fixtures are part of CARTOGRAPH's reproducible evaluation corpus,
not an untracked sample dump. Their source, license, commit/reference,
transformation, and local redistribution decision are recorded in
[`test/fixtures/provenance.json`](../test/fixtures/provenance.json), validated
by [`schema/fixture-provenance.v0.1.schema.json`](../schema/fixture-provenance.v0.1.schema.json).

Run the validator with:

```sh
npm run fixtures:validate
```

The validator enumerates every immediate fixture directory, rejects omitted or
duplicate entries, rejects symbolic links, and checks for generated-directory
names (`build`, `coverage`, `dist`, `node_modules`, `out`, `vendor`, and related
names). Any generated output must have a non-empty reason in the manifest. A
fixture that is intentionally a generated-directory lookalike is still
declared; the reason records why it is present and why it must remain excluded.

The initial corpus is repository-authored synthetic material under the
Apache-2.0 license. If an external fixture is added, its upstream reference,
exact commit or release, transformation note, and redistribution decision must
be recorded before it is checked in. Do not copy source from an upstream
repository without confirming that local redistribution is permitted.

The `generated-provenance` fixture intentionally contains both selected and
excluded generated TypeScript. It verifies that selected modules are classified,
explicit `generated-from` markers retain source relationships, and excluded
distribution or configured output paths are reported with an exact path and
reason rather than omitted silently.
