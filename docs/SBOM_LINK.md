# Linking SBOMs and build provenance to the graph

`cartograph sbom link` relates the released software inventory (an SBOM, and
optionally the build's SLSA provenance) to the architecture graph of the
source revision it was built from. The output is `cartograph.sbom-link` v1
([schema](../schema/sbom-link.v0.1.schema.json)).

```sh
cartograph sbom link --snapshot graph.json --sbom bom.cdx.json \
  --provenance build.intoto.json --alias real-fetch=fetch-alias
```

## Inputs

| Input      | Accepted                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Snapshot   | Any CARTOGRAPH graph snapshot (legacy snapshots are migrated).                                                                                                                                                                                         |
| SBOM       | CycloneDX JSON 1.4–1.6 (`metadata.component`, `components`, nested `components`, `SHA-256` hashes, `purl`), or SPDX JSON 2.2–2.3 (`packages`, `files`, `documentDescribes`, `CONTAINS` relationships, `SHA256` checksums, `purl` external references). |
| Provenance | An in-toto Statement (v0.1 or v1) with a SLSA provenance predicate. Subjects need SHA-256 digests. Source commits come from `resolvedDependencies` (v1) or `materials` (v0.2) `gitCommit` or `sha1` digests.                                           |

Inputs are local files up to 64 MiB. Nothing is fetched. More than 50,000
components or nesting deeper than 32 levels is rejected. A component without
a name is listed under `malformed`, and the rest of the SBOM is still linked.

## How components are linked

| Component                                  | Graph object                                                                                      | Method             | Confidence |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------ | ---------- |
| npm `purl` (`pkg:npm/%40scope/name@1.0.0`) | `module:external:<name>` from lockfiles and imports, or a workspace `package` node with that name | `purl`             | certain    |
| No `purl`                                  | the same, by component name                                                                       | `name`             | inferred   |
| `--alias sbom-name=graph-name`             | the graph name, for npm aliases (`"x": "npm:real@1"`)                                             | `alias`            | certain    |
| `file` component                           | the module at that repository path                                                                | `file-path`        | certain    |
| File that CARTOGRAPH saw as generated      | the generated module, plus the source it was generated from                                       | `generated-source` | inferred   |

Every component gets one status:

- `linked`: one graph object (or a file and its generator sources).
- `ambiguous` (`multiple-graph-objects`): more than one object matches, for
  example an external package and a workspace package with the same name.
  All candidates are listed, and none is chosen.
- `unresolved`, with a reason:
  - `not-in-graph`: the analyzed code neither imports nor declares it.
  - `bundled-in-artifact`: it is nested in, or `CONTAINS`-ed by, another
    component, so it ships inside that artifact rather than as a dependency
    edge.
  - `unsupported-ecosystem`: a non-npm `purl`.

A graph object targeted by components with different versions is listed in
`versionSkew`, and those components keep their link with reason
`version-skew`. External packages in the graph that no component reaches are
listed in `graphOnly` (`not-in-sbom`).

## Build artifacts

Each provenance subject is related to the SBOM components whose SHA-256
matches it, and to a package node whose name matches an npm tarball name
(`@scope/name` → `scope-name-<version>.tgz`). A subject that matches neither
is `unresolved`. `sourceRevision` says whether the provenance names the
snapshot's commit (`matches`), names other commits (`differs`), or names none
(`not-recorded`). `differs` means the graph does not describe the source this
build came from.

## What this does not claim

`coverage` counts only what was measured: SBOM components by status, and how
many of the graph's external packages any component reached. It is not a
completeness or vulnerability claim. CARTOGRAPH does not check that an SBOM
is complete, that its hashes match real artifacts, or that a provenance
statement is signed. Verify those with the tools that produced them (for
example `gh attestation verify` or `cosign verify-attestation`) before
relying on the link.
