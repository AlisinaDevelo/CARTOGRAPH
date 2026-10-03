# Local architecture history

`cartograph history` keeps a local, content-addressed store of the records
needed for longitudinal analysis: snapshots, diffs, policies, decisions,
finding lifecycles, workspace compositions, and the analyzer provenance that
produced them. It is a directory: no service, database, network access, or
telemetry is involved. The default location is `.cartograph/history`.

```sh
cartograph history import -r snapshot=graph.json -r diff=diff.json -r policy=.cartograph/policy.json
cartograph history list --revision <sha>
cartograph history verify
cartograph history export --revision <sha> -o exported/
cartograph history repair
```

## Records and references

Each input is validated against its CARTOGRAPH contract and stored as a
`cartograph.history-record` ([schema](../schema/history-record.v0.1.schema.json)):
the record kind, the body's contract schema version, the revision it
describes, explicit references, and the canonical body. The record's ID is the
SHA-256 of its canonical bytes, and it is written once to
`objects/<first two hex>/<id>.json` and never modified. Importing the same
content again is a no-op. Records carry no timestamps, so identical inputs
always produce the same IDs.

A snapshot record carries its commit as `revision`. A diff record carries its
head commit and references both revisions it connects (`revision:<sha>`).
`verify` reports references to revisions whose snapshot was never imported,
but they don't fail verification, because a store may hold only diffs.

Every import also stores a `provenance` record: the tool version and the
analyzer fingerprint of the build that ran the import.

## Index

`index.json` ([schema](../schema/history-index.v0.1.schema.json)) lists every
record's ID, kind, schema version, revision, and references. It is derived
from the objects and can always be rebuilt.

## Integrity, recovery, and concurrency

- Objects and the index are written to a temporary file and renamed into
  place, so a crash never leaves a partial record.
- An exclusive `lock` file serializes imports and repairs. A lock left by an
  interrupted run is reported. `repair` clears it.
- `verify` checks that each object's name matches the digest of its bytes,
  that the bytes are the canonical form of a valid record whose body still
  satisfies its contract, and that the index matches the objects. It exits 2
  on corrupt, missing, or unindexed records, an inconsistent index, or
  leftover files.
- `repair` moves corrupt objects to `quarantine/` (it deletes nothing valid),
  removes leftover temporary files and a stale lock, and rebuilds the index
  from the valid objects.

## Migration

Legacy (v0) snapshots are migrated to the current snapshot contract when
imported, so the store only holds current-version bodies, and each record
records its body's schema version. The store format itself is version 1. A
future store version will ship a `history migrate` step that rewrites records
into new objects and rebuilds the index, leaving the old objects for rollback
until they are removed explicitly.

## Export

`export` writes the selected records' bodies as standalone contract
documents (for example `snapshot-<id prefix>.json`) to a new directory. Those
documents can be passed to any CARTOGRAPH command or packaged with
`cartograph bundle create`.
