# v0.1.0 release acceptance and rollback rehearsal

Record version: `release-rehearsal.v0.1`; package/tag under review: `0.1.0` /
`v0.1.0`; review date: 2026-08-25; mode: local and dry-run only. This record is
versioned with the release contract and must be copied and updated for each
future package version.

## Acceptance checklist

The candidate is accepted only when every row has current evidence. The local
Node 24 and Node 26 runs are the acceptance evidence while hosted Actions are
unavailable; no hosted result is implied by this record.

| Gate                            | Command or evidence                                                                                                                      | v0.1.0 result                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Clean checkout and source state | `git status --short --branch`; `git diff --check`                                                                                        | Passed on protected `main`                                                                     |
| Runtime support window          | `PATH=<Node 24> npm run check`; `PATH=<Node 26> npm run check`                                                                           | Passed on Node 24.19.0 and Node 26.7.0                                                         |
| Clean installation              | `npm ci --ignore-scripts --no-audit --no-fund`; `npm pack --dry-run`                                                                     | Passed locally; lifecycle scripts remain disabled for review                                   |
| Representative scans and diffs  | `npm run quickstart:validate`; `npm run workflow:validate`; `npm run action:validate`                                                    | Passed; scan, diff, policy, and review fixtures are deterministic                              |
| Read-only Action behavior       | `npm run action:validate`; `npm run action:security:validate`                                                                            | Passed; fork fixtures retain read-only contents and no secrets                                 |
| Package contents                | `npm run release:validate`                                                                                                               | Passed; tarball, SBOM, provenance, checksum, and consumer smoke metadata generated and cleaned |
| Signature and provenance        | `gh attestation verify <asset> --repo AlisinaDevelo/CARTOGRAPH --signer-workflow AlisinaDevelo/CARTOGRAPH/.github/workflows/release.yml` | Required for a hosted release; no live release asset was created during this rehearsal         |
| Documentation and limitations   | `npm run docs:links:validate`; review `docs/QUICKSTART.md`, `docs/SUPPORT_MATRIX.md`, and `docs/THREAT_MODEL.md`                         | Passed; links and known unsupported behavior remain explicit                                   |
| Security and dependency review  | local `npm run check`, dependency review, and CodeQL when hosted capacity returns                                                        | Local gates passed; hosted checks are deferred, not silently claimed                           |

The release artifact must be produced from the exact protected commit and its
package version must match the tag. Generated `dist`, coverage, temporary
repositories, reports, and package tarballs are evidence outputs, not source
release subjects.

## Dry-run rollback rehearsal

### Scenario and guard

Scenario: a consumer reports a correctness or security defect in `v0.1.0`
after publication. This rehearsal uses read-only inspection and a written
action plan only. It does not edit a GitHub release, delete or retag a Git tag,
publish to npm, or alter an active release.

### Owners and recovery targets

| Role                 | Owner during a real incident      | Responsibility                                                       |
| -------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Release owner        | Maintainer on duty                | Freeze promotion, preserve evidence, coordinate the patch gate       |
| Security owner       | Security contact in `SECURITY.md` | Triage exploitability and coordinate disclosure                      |
| Communications owner | Maintainer on duty                | Withdraw guidance, publish the replacement version, and answer users |

Recovery targets are detection and internal acknowledgement within 30 minutes,
withdrawal guidance within 60 minutes, a reviewed patch candidate within 4
hours, and a fully gated corrective release within 1 business day when no
upstream dependency fix is required. These are rehearsal targets, not an SLA.

### Read-only rehearsal commands

The following commands inspect the candidate and preserve evidence without
changing hosted state:

```sh
git show --stat --oneline v0.1.0
git tag --verify v0.1.0
git ls-remote --tags origin refs/tags/v0.1.0
gh release view v0.1.0 --repo AlisinaDevelo/CARTOGRAPH
gh issue list --repo AlisinaDevelo/CARTOGRAPH --state open --label priority:P0
```

The following real-incident commands are recorded for completeness but were
not executed during this dry run:

```sh
# Withdraw guidance in the release notes; never retag v0.1.0.
gh release edit v0.1.0 --repo AlisinaDevelo/CARTOGRAPH --notes-file withdrawal.md
# Build and gate a corrective patch from protected main, for example v0.1.1.
git switch main
git tag v0.1.1
git push origin v0.1.1
```

### Communication and follow-up

1. Release owner opens a private incident record with the report, affected
   commit/tag, package digest, severity, and a pointer to preserved logs.
2. Communications owner tells users to stop installing the affected version,
   links the replacement or safe source build, and records the exact UTC times.
3. Security owner follows the coordinated-disclosure policy when the defect is
   security-sensitive; no private details are placed in public issue history.
4. Release owner creates a corrective patch issue, reruns this checklist, and
   attaches the new tarball, SBOM, provenance, checksum, and consumer smoke
   evidence.
5. After recovery, the owners record root cause, detection gap, recovery time,
   communication outcome, and any checklist or support-matrix follow-up.

Rehearsal disposition: **ready for a real, explicitly authorized incident**;
no active release was altered and no publication command was run.
