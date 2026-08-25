# Adapter lifecycle and security response

Status: accepted for E-011

This policy defines what happens when a CARTOGRAPH adapter loses ownership,
falls below its quality boundary, or has a security defect. It is a local
maintainer control, not a hosted-service SLA. The versioned source of truth is
[`test/fixtures/adapter-lifecycle/scenarios.v0.1.json`](../test/fixtures/adapter-lifecycle/scenarios.v0.1.json),
validated by `npm run adapter:lifecycle:validate` against
[`schema/adapter-lifecycle.v0.1.schema.json`](../schema/adapter-lifecycle.v0.1.schema.json).

## Ownership

Every implemented or experimental matrix entry has a primary owner and a
backup. The matrix owner reviews ownership quarterly and before every minor
release. An owner gap freezes new capability claims immediately. If no owner
or backup acknowledges within the published review window, maintainers move the
entry to `warning`, replay the adapter evidence, and begin deprecation rather
than silently leaving an unsupported claim active.

The policy currently names `@AlisinaDevelo` as primary, `extractor-maintainers`
as backup, and `CARTOGRAPH maintainers` as the matrix owner. A repository entry
must still name its own owner and backup; this default does not transfer
responsibility automatically.

## Vulnerability intake

Suspected vulnerabilities use GitHub private vulnerability reporting. If that
route is unavailable, the reporter contacts the maintainer privately through
the AlisinaDevelo profile. Public issues and discussions are not the intake
route for an unpatched vulnerability. Reports should include the affected
commit, command or input, operating system, impact, and a minimal redacted
reproduction. Secrets, credentials, proprietary source, and public exploit
details are prohibited.

The first response records the trust boundary and affected adapter versions,
freezes promotion and releases, and limits reproduction to synthetic or
redacted fixtures. A public advisory is coordinated only after containment and
an actionable mitigation or fix. The response targets in the tabletop are
internal rehearsal targets, not a response-time promise to reporters.

## Support windows and quality triggers

The v0.1 windows are:

| Adapter state |   Support window |                 Notice window | Historical snapshots |
| ------------- | ---------------: | ----------------------------: | -------------------: |
| Stable        |         365 days |                       90 days |  1,095 days readable |
| Experimental  |          90 days |                       30 days |  1,095 days readable |
| Unreleased    | no support claim | 14-day internal notice target |  1,095 days readable |

The quality floors are precision `0.90`, recall `0.85`, and evidence
completeness `1.00` for the explicitly supported slice. A precision or recall
regression enters `warning`; incomplete evidence or an open security finding
blocks promotion and releases. An owner acknowledgement gap beyond 30 days
starts deprecation. These triggers do not turn unsupported constructs into
false positives: unknown behavior remains diagnostic and evidence-linked.

## Deprecation, archive, and replacement

A deprecation notice names the adapter, reason, effective date, replacement,
migration, and remaining support window. It is published through release notes,
support documentation, and a public tracking issue after private security
containment when applicable. The minimum stable notice window is 90 days.

Archiving removes the active support claim but preserves historical snapshots
and evidence and requires a migration note. The repository is not automatically
archived: maintainers retain the source needed to read old artifacts and explain
the boundary. Replacement guidance names a concrete replacement ID, semantic
scope, migration, and compatibility dimensions. A replacement is not promoted
implicitly; it must pass its own support-matrix, conformance, security, and
equivalence review.

## Tabletop exercises

The checked-in tabletop corpus covers two bounded incidents:

1. **Abandoned adapter:** an owner gap moves the entry through warning,
   evidence review, deprecation notice, migration recording, and archive while
   preserving historical artifacts.
2. **Security defect:** a private critical report triggers intake, containment,
   an advisory, a fix and hostile-fixture replay, then coordinated disclosure
   and return to active support only after review.

Each event has an owner, an hour target, a deadline, a resulting lifecycle
state, and a public communication template. The validator enforces ordered
timelines, bounded deadlines, required actions, template completeness, no
source/secret disclosure markers, and deterministic repeated output.
