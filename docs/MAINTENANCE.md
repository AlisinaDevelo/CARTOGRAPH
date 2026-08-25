# Maintenance and ownership

This document names the current owners of the public project baseline. It is a
small operational contract, not a promise of a response-time or release SLA.

## Maintainer ownership

The current maintainer is [`@AlisinaDevelo`](https://github.com/AlisinaDevelo).
The repository-wide [CODEOWNERS](../.github/CODEOWNERS) rule requests maintainer
review for every path. The maintainer owns:

- graph, evidence, diagnostic, and CLI compatibility decisions;
- security-boundary and privacy review;
- branch protection, required checks, and release-readiness decisions; and
- roadmap, support-matrix, and public documentation updates.

Material changes to those surfaces still require a public RFC issue as described
in [`GOVERNANCE.md`](../GOVERNANCE.md). Routine fixes require focused tests and
the completion evidence described in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

The role map, onboarding path, backup routes, and non-author rehearsals are
recorded in [`MAINTAINER_RESILIENCE.md`](MAINTAINER_RESILIENCE.md). Its
`documented-unverified` backup status is intentional: the map does not claim a
staffed second maintainer.

## Required merge checks

Protected `main` requires these status-check contexts when hosted GitHub checks
are available:

- `Node 22.x`
- `Node 24.x`
- `Analyze (javascript-typescript)`
- `Review dependency changes`

The workflows are intentionally read-only with respect to repository contents.
The local replacement for the same gate is `npm run check`, including
`npm run benchmark:ci`, followed by package and installed-CLI smoke tests. The
benchmark gate runs inside both Node matrix jobs, so those job contexts include
its result. A local run is retained as evidence when hosted checks are
unavailable; it is not a claim that hosted checks ran.

The schema compatibility check is part of `npm run check`; it rejects drift
between runtime constants, the published schema, and the reviewed compatibility
manifest.

Adapter ownership, quality floors, support windows, deprecation, archive
behavior, and private security response are governed by the
[adapter retirement policy](ADAPTER_RETIREMENT.md). Its two timed tabletop
exercises run as `npm run adapter:lifecycle:validate`; tabletop deadlines are
internal rehearsal targets, not a public response-time SLA.

## Dependency-update ownership

Dependabot owns update proposals, not automatic merging. The configuration in
[`../.github/dependabot.yml`](../.github/dependabot.yml) checks npm weekly and
GitHub Actions monthly, waits seven days by default, groups npm minor/patch
updates, and limits concurrent pull requests. The maintainer owns:

1. reviewing the lockfile and changelog impact;
2. rerunning the full local gate on the target device;
3. checking security and license impact; and
4. merging only after the protected-branch review policy is satisfied.

Major TypeScript and `@types/node` updates remain explicit decisions rather than
unattended Dependabot upgrades.

## Security disclosure ownership

Security reports must use [GitHub private vulnerability reporting](https://github.com/AlisinaDevelo/CARTOGRAPH/security/advisories/new)
when enabled, or the private maintainer fallback in [`SECURITY.md`](../SECURITY.md).
The maintainer owns triage, impact assessment, a fix or mitigation, and a
coordinated disclosure decision. Reporters should provide the affected commit,
command/input, operating system, impact, and a minimal redacted reproduction;
never include credentials, proprietary source, or a public exploit.

The project is unreleased, so no fixed response-time, embargo, or release-date
promise is made. The maintainer records the affected boundary, validation result,
and disclosure decision in the private report and public release notes when a
public release exists.

## Review cadence

Review this document at least quarterly and before a minor release, or sooner
when the supported Node/OS matrix, dependency policy, workflows, security
boundary, maintainer, or disclosure route changes.
