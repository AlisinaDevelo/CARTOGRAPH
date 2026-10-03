# Local export and import boundary review (M-018)

This review covers moving CARTOGRAPH evidence between people and machines
using local files only: `bundle create`, `verify`, `check`, `share`, and
`payload`; `history import`, `export`, `verify`, `repair`, and `trends`; and
`export`. It does not cover accounts, hosted services, sync, or any workflow
that needs the network. Those need their own ADR and security gate (see
[Gate for anything beyond local handoff](#gate-for-anything-beyond-local-handoff)).

## Scope and decision

Handoff stays bounded, local, and offline. A person moves a directory by
whatever means they already trust: a file share, an attachment, or a commit
to a repository they control. CARTOGRAPH produces and checks the directory.
It never sends, fetches, or syncs it. This keeps
[ADR 0007](adr/0007-local-first-investment-boundary.md) and the
[strategy review](STRATEGY_PRIVACY_SECURITY_REVIEW.md) unchanged.

## Assets and actors

- **Assets:** architecture evidence about a private repository (paths, symbol
  names, hosts, policy and decision text, findings, waivers), and the local
  signing and pseudonymization keys.
- **Producer:** runs CARTOGRAPH on their machine and decides what to hand
  off.
- **Recipient:** receives a directory and runs `bundle verify` or
  `history import` on it. The recipient does not trust the producer's
  machine, only the files and, optionally, a signature from a trusted key.
- **Out of scope:** an attacker who controls either machine, and the
  transport between them.

## Identity

There are no accounts. Two kinds of identity exist, and both come from
contents:

- **What:** content addresses. A bundle's `bundleId` and every artifact are
  SHA-256 digests over canonical bytes. A history record's ID is the digest
  of its canonical serialization.
- **Who:** an optional Ed25519 signature over the bundle manifest, checked
  against a local keyring and explicitly trusted roots
  ([ASSURANCE_SIGNING.md](ASSURANCE_SIGNING.md)). Without a signature, a
  bundle proves integrity, not origin.

## Authorization

Authorization is the operating system's file permissions. CARTOGRAPH
implements no access control and makes no claim to.

- History objects, the index, and locks are written `0600` in `0700`
  directories. Bundles are written `0644` because they are meant to be read
  by someone else.
- New output directories must be empty (`bundle create`, `bundle share`,
  `history export`), so a handoff never merges into or overwrites an existing
  directory.

## Integrity checks on import

| Step          | Control                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Read an input | Regular files only (no symbolic links or special files), size ceilings before parsing                                               |
| Parse         | Every record or artifact must satisfy its contract; legacy snapshots are migrated, everything else is rejected                      |
| Store         | Canonical bytes, content-addressed names, atomic write and rename, exclusive lock                                                   |
| Deduplicate   | An existing object is re-read and must equal the new bytes, otherwise import stops and points to `history repair`                   |
| Store root    | `history import` refuses a store or `objects/` directory that is a symbolic link                                                    |
| Verify        | `bundle verify` and `history verify` recompute every digest and re-validate every contract; `bundle verify --signature` adds origin |

## Conflict handling

Content addressing makes a re-import of the same evidence a no-op. Two
_different_ snapshots of the same revision (for example, scans from two
analyzer versions, or a hand-edited file) are both kept, and `history import`
reports them under `conflicts`. Nothing is silently overwritten.
`history trends` refuses to pick one: it fails for that revision and asks for
exactly one. Resolve the conflict by exporting the record to keep and
rebuilding the store.

## Retention

Nothing expires automatically, and CARTOGRAPH keeps no copies outside the
directories you name. [SHARING.md](SHARING.md#retention-and-deletion)
describes deletion for bundles, the history store, quarantine, and
pseudonymization keys.

## No-network defaults

No source file imports a network module or calls `fetch`. A static test in
`test/security/offline.test.ts` enforces this, alongside the existing runtime
test that a scan of untrusted code makes no network call. Signature
verification uses only the local keyring and the trust roots given on the
command line. There is no key discovery, revocation lookup, or timestamp
service.

## Findings from this review

| Finding                                                                                                                             | Resolution                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Import trusted an existing object by name without reading it, so a tampered object could be reported as `existing` and stay indexed | Fixed: import compares bytes and fails closed                                                               |
| A symbolic-linked store directory could redirect writes outside the intended path                                                   | Fixed: import refuses a symbolic-linked store root or `objects/`                                            |
| Conflicting snapshots of a revision were stored silently                                                                            | Fixed: import reports `conflicts`; `trends` already refused ambiguity                                       |
| Nothing enforced the no-network claim in code, only at scan time                                                                    | Fixed: static source test                                                                                   |
| A bundle carries no record of who produced it unless it is signed                                                                   | Accepted: documented; sign bundles that cross a trust boundary                                              |
| History records carry no origin once imported                                                                                       | Accepted: provenance records name the analyzer build, not a person; origin is out of scope without accounts |
| A bundle shared under the wrong profile can leak paths and names                                                                    | Mitigated by `bundle check` and `bundle share` ([SHARING.md](SHARING.md))                                   |
| Concurrent writers that bypass the lock, and filesystem races between check and use                                                 | Accepted: outside the guarantee, same as the Action path checks                                             |

## Gate for anything beyond local handoff

An account, hosted service, sync, remote store, network transport, key
server, or required online step changes the trust boundary. Before any of
these is designed, it needs a public RFC, a separate ADR, an update to
[THREAT_MODEL.md](THREAT_MODEL.md), and its own security gate covering
authentication, tenant isolation, authorization, retention, and incident
response. Nothing in this review approves one.
