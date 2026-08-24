# Schema migrations

Each migration must be explicit, deterministic, and reviewed with a fixture.
Name a migration `<contract>-v<from>-to-v<to>.md` and record:

- the source and target contract versions;
- whether information is lost or newly required;
- the command or library path that performs the migration;
- valid, invalid, and boundary fixtures; and
- the compatibility and security review decision.

An older artifact with no migration is rejected with an actionable error. Do
not silently reinterpret an unknown schema version as the current version.

The published transition matrix is
[`migration-matrix.v0.1.json`](migration-matrix.v0.1.json); the historical
GraphSnapshot v0-to-v1 review record is
[`snapshot-v0-to-v1.md`](snapshot-v0-to-v1.md).
