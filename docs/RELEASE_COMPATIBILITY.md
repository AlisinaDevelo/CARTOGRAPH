# Release compatibility matrix

The machine-readable source is
[`schema/release-compatibility-matrix.v0.1.json`](../schema/release-compatibility-matrix.v0.1.json).
`npm run release-compatibility:validate` checks that this document, the support
matrix, compatibility manifest, adapter contract, pinned Actions, CI matrix,
and release workflow agree. The validator fails clearly when an unsupported
runtime, operating-system, artifact version, or Action reference is introduced.

Matrix ID: `cartograph-release-compatibility-v0.1`

Matrix digest: `sha256:3cb9d7481a66e2b079e3bfe727ebb31f89a5ba073f23e25e037f90915801810f`

## Tested combinations

The release gate exercises every Cartesian product of the declared Node and OS
lines. Each row also runs the current snapshot, diff, policy, adapter, and
composite Action contracts.

| OS              | Node   | Snapshot | Diff | Policy | Adapter API | Adapter compatibility | Action  |
| --------------- | ------ | -------: | ---: | -----: | ----------: | --------------------: | ------- |
| `ubuntu-latest` | `22.x` |        1 |    1 |      1 |           1 |                     1 | `0.1.0` |
| `ubuntu-latest` | `24.x` |        1 |    1 |      1 |           1 |                     1 | `0.1.0` |
| `macos-latest`  | `22.x` |        1 |    1 |      1 |           1 |                     1 | `0.1.0` |
| `macos-latest`  | `24.x` |        1 |    1 |      1 |           1 |                     1 | `0.1.0` |

The composite Action itself runs on Node `24.x`. Its pinned dependencies are
`actions/checkout@v7.0.1`, `actions/setup-node@v7.0.0`, and
`actions/upload-artifact@v4.6.2`; the matrix records their immutable commit
references.

## Release record

Every release artifact includes `compatibility-matrix.json`. The record binds
the matrix digest, package version and tag, source commit, actual release
builder runtime, pinned Action references, contract versions, and all tested
rows. It is emitted by the release artifact builder and is included in the
release checksums and attestation subjects.

The package is not published for unsupported combinations. Readers and release
automation fail closed when a contract version, Node/OS row, adapter version, or
Action reference is absent from this matrix; adding support requires a matrix
update, documentation update, and compatibility review in the same change.
