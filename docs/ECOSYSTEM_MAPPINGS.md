# Ecosystem format mappings

CARTOGRAPH's contracts are its own. Where a widely used format can carry part
of the same information, it maps that part explicitly, and the mapping says
what is lost. Every export is opt-in: nothing is written in another format
unless a command asks for it. This page covers each mapping's direction,
version negotiation, identifiers, evidence, lossiness, and unsupported
concepts. `npm run ecosystem-mappings:validate` measures the lossiness on
checked-in fixtures.

## Summary

| Format                           | Direction                                                | Command                                                | Versions accepted or produced                                               |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| SARIF                            | export and import                                        | `policy --format sarif`, `importSarifPolicyEvaluation` | 2.1.0 only                                                                  |
| CycloneDX                        | export; import for linking                               | `export --format cyclonedx`; `sbom link`               | produces 1.6; accepts 1.4–1.6                                               |
| SPDX                             | import for linking                                       | `sbom link`                                            | accepts 2.2–2.3 JSON                                                        |
| OpenTelemetry (OTLP/JSON traces) | import                                                   | `reconcile-runtime`                                    | OTLP JSON `resourceSpans`                                                   |
| in-toto / SLSA                   | export (Statement); import (SLSA provenance for linking) | `bundle statement`; `sbom link --provenance`           | Statement v1; accepts Statement v0.1 and v1 with SLSA v0.2 or v1 predicates |

**Version negotiation is strict.** An input whose declared version is not in
the accepted list is rejected with the version it found and the versions it
accepts. Nothing is parsed on a best-effort basis. Exports always declare
their exact version.

## SARIF 2.1.0

- **Maps:** each policy violation whose matched graph objects all have
  line-local source locations becomes a `fail` result. The rule ID, policy
  identity, and a fingerprint of the graph references are kept in result
  properties. Import verifies the fingerprints and restores the same graph
  and evidence references ([details](SARIF_INTERCHANGE.md)).
- **Identifiers:** SARIF `ruleId` is the policy rule ID. Result fingerprints
  are CARTOGRAPH evaluation IDs.
- **Lossy:** graph references become physical locations (transformed).
- **Unsupported:** aggregate, global, and source-less violations are listed
  as unsupported and never shown as a result. SARIF code flows, taxonomies,
  and result kinds other than `fail` are rejected on import.

## CycloneDX

- **Export (1.6):** external packages (from imports and lockfiles) and
  workspace packages become `library` components, and the root package
  becomes `metadata.component`. `depends_on` edges between them become
  `dependencies`. `bom-ref` is the graph node ID, which is repeated in the
  `cartograph:nodeId` property. purls are `pkg:npm/<name>`, with the scope
  `@` percent-encoded. The serial number is derived from the content, and
  there is no timestamp, so the same graph always gives the same bytes.
- **Lossy:** the graph records no package versions, so components and purls
  carry none. Modules, functions, endpoints, and all non-package nodes are
  dropped, as are edge confidence and evidence locations. A name shared by an
  external package and a workspace package links back ambiguously, because
  name-only purls cannot tell them apart.
- **Import:** `sbom link` relates CycloneDX components to graph objects with
  a method, confidence, and unresolved reasons ([details](SBOM_LINK.md)).
- **Not a complete inventory:** the export says so in a
  `cartograph:limitation` property.

## SPDX 2.2–2.3

- **Import only, for linking:** packages (with purls), files, the described
  package, and `CONTAINS` relationships ([details](SBOM_LINK.md)). There is
  no SPDX export. The CycloneDX export covers the same package set, and
  SPDX 3 is not yet accepted.

## OpenTelemetry

- **Import only:** OTLP/JSON trace exports become CARTOGRAPH runtime spans
  (trace and span IDs, parent, name, kind, timing, status, and service and
  scope names) ([details](RUNTIME_TRACES.md)). Attributes outside the
  allowlist are discarded and counted. Request bodies, headers, and
  user-identifying attributes never enter the graph.
- **Unsupported:** metrics, logs, OTLP/protobuf, and span links or events.
  CARTOGRAPH does not export telemetry.

## in-toto and SLSA

- **Export:** `bundle statement` prints an unsigned in-toto Statement v1.
  Its subjects are `manifest.json` and every artifact, by SHA-256, and its
  predicate (`…/predicate/assurance-bundle/v1`) carries the bundle ID, tool,
  analyzer fingerprint, roles, and declared missing roles. Sign it with an
  in-toto tool to publish an attestation. Media types, byte sizes, and labels
  are not subject fields and are dropped. They remain in the bundle manifest.
- **Import:** `sbom link --provenance` reads SLSA provenance subjects and
  source commits to relate builds to the graph revision.

## Measured lossiness

The validator replays each mapping on fixtures and compares the counts with
`test/fixtures/ecosystem-mappings/expected.v0.1.json`:

| Format               | Unit             | Input | Preserved | Transformed | Dropped          | Ambiguous |
| -------------------- | ---------------- | ----- | --------- | ----------- | ---------------- | --------- |
| SARIF 2.1.0          | policy violation | 2     | 1         | 1           | 1                | 0         |
| CycloneDX 1.6        | graph node       | 12    | 7         | 2           | 3                | 2         |
| SPDX 2.3             | SBOM element     | 6     | 4         | 2           | 2                | 0         |
| OTLP/JSON            | span             | 1     | 1         | 1           | 0 (5 attributes) | 0         |
| in-toto Statement v1 | bundle artifact  | 1     | 1         | 0           | 0 (3 fields)     | 0         |

"Preserved" means the item survives the round trip, or the one-way import,
with the same identity. "Transformed" means it is represented differently
(for example a graph reference becomes a SARIF location, or a scoped name
becomes an encoded purl). "Dropped" means it has no representation.
"Ambiguous" means it comes back matching more than one object.

## Upstream schema validation

| Format               | Upstream schema                                                                                  | Status                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CycloneDX 1.6        | vendored from [CycloneDX/specification](https://github.com/CycloneDX/specification) (Apache-2.0) | exports validated in tests and in `ecosystem-mappings:validate`                                                                                                                            |
| SARIF 2.1.0          | not vendored                                                                                     | the OASIS repository's terms are a link to the OASIS IPR policy rather than a file license, so the schema is not redistributed here; output is checked against CARTOGRAPH's SARIF contract |
| in-toto Statement v1 | none published                                                                                   | in-toto defines the Statement in prose and protobuf, without a JSON Schema; output is checked against the specification's required fields                                                  |
| SPDX, OTLP           | not needed                                                                                       | import only                                                                                                                                                                                |

Vendored files live in `schema/vendor/` with their license and are recorded
in `schema/vendor/provenance.json`: source repository, commit, and SHA-256
of every file. Tests fail if a vendored file changes. The CycloneDX schema
uses the `iri-reference` and `idn-email` formats, which are checked with
their stricter ASCII counterparts (`uri-reference`, `email`).
