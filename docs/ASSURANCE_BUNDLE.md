# Assurance bundles

An assurance bundle packages what was analyzed and decided (snapshots, diffs,
policies, evaluations, decisions, lifecycle records, waivers, query results,
configuration, and reports) so someone else can check it offline without the
repository or its source. The manifest contract is
[`schema/assurance-bundle.v0.1.schema.json`](../schema/assurance-bundle.v0.1.schema.json)
(`cartograph.assurance-bundle` v1).

```sh
cartograph bundle create -o bundle/ \
  -a snapshot-head=graph.json -a diff=diff.json -a policy=policy.json \
  -a policy-evaluation=evaluation.json -a report-html=diff.html \
  --require waiver --missing "waiver=no waivers are in use"
cartograph bundle verify bundle/
```

## Layout

```text
bundle/
  manifest.json
  artifacts/<role>-<first 12 hex of sha256>.<json|html|md|sarif>
```

The manifest records the tool version, the fixed size limits, the required
roles, and one entry per artifact: role, bundle-relative path, media type,
SHA-256, and byte length. `bundleId` is the SHA-256 of the canonical manifest
body. Artifacts are sorted by role and path, the manifest is written in
canonical key order, and nothing time- or host-dependent is recorded, so
creating a bundle twice from the same inputs produces identical bytes.

## Roles and contracts

| Role                             | Media type                   | Validated as                             |
| -------------------------------- | ---------------------------- | ---------------------------------------- |
| `snapshot-base`, `snapshot-head` | `application/json`           | GraphSnapshot                            |
| `diff`                           | `application/json`           | GraphDiff                                |
| `policy`                         | `application/json`           | local policy                             |
| `policy-evaluation`              | `application/json`           | policy evaluation                        |
| `decisions`                      | `application/json`           | ADR reference document                   |
| `finding-lifecycle`              | `application/json`           | finding lifecycle input                  |
| `waiver`                         | `application/json`           | architecture waiver                      |
| `query-result`                   | `application/json`           | graph query or architecture query result |
| `review-summary`                 | `application/json`           | review summary report                    |
| `configuration`                  | `application/json`           | CARTOGRAPH config                        |
| `adapter-manifest`               | `application/json`           | JSON                                     |
| `report-html`, `report-markdown` | `text/html`, `text/markdown` | not parsed                               |
| `report-sarif`                   | `application/sarif+json`     | JSON                                     |

There is no role for source files. Every carried contract is source-body-free,
and the manifest states `sourceBodiesIncluded: false`.

## Limits and missing artifacts

A bundle holds at most 128 artifacts, 64 MiB each, 512 MiB in total. The
creator lists the roles the bundle must contain (by default, the roles it was
given). A required role that is intentionally absent must be declared with a
reason (`--missing role=reason`). Creation fails if a required role is neither
present nor declared missing, or if a declared-missing role is present.

## Offline verification

`bundle verify` needs only the directory. It fails (exit 2) and lists each
problem when:

- the manifest is invalid, not canonical, or its `bundleId` doesn't match;
- a listed artifact is missing, has a different size or digest, is not named
  for its digest, has the wrong media type, or no longer matches its contract;
- a file exists that the manifest doesn't list;
- a required role is absent without a declaration.

Symbolic links and special files inside a bundle are refused outright.
Signing a bundle's manifest digest is covered by
[assurance signing](ASSURANCE_SIGNING.md).
