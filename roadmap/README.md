# CARTOGRAPH managed roadmap

`manifest.json` is the managed roadmap source for CARTOGRAPH's public GitHub milestones, labels, and issues. Keep the manifest reviewable in this repository; do not hand-edit generated GitHub issue text as a substitute for changing the manifest.

The manifest contains 20 dated rolling-quarter milestones (`Year 1 Q1` through `Year 5 Q4`), 179 managed issues, and 514 prerequisite relationships. Each issue has a stable ID, a problem/outcome statement, measurable acceptance criteria, dependencies, labels, priority, milestone, and an explicitly open default state. Milestone dates are planning boundaries, not delivery promises; exit gates decide whether later scope proceeds.

## Local commands

From the repository root:

```text
node scripts/github-roadmap.mjs validate
node --test roadmap/github-roadmap.test.mjs
node scripts/github-roadmap.mjs plan --repo OWNER/REPO
node scripts/github-roadmap.mjs apply --repo OWNER/REPO --confirm
```

`validate` is fully offline. `plan` reads the repository's current labels, milestones, issues, due dates, and native blocked-by relationships through the GitHub CLI (`gh`) and emits create/update/noop operations without writing. `apply` is the only mutating command and requires the explicit `--confirm` flag; it uses rate-spaced `gh api` calls with argument arrays, stable HTML markers, bounded post-write verification, a second body-link pass, and an additive native dependency pass. Marker, duplicate, ownership, identity, and incomplete-discovery collisions remain fail-closed.

The CLI manages only configured label names, marked milestones, and marked issues already bound to one of those managed milestones. That milestone binding prevents a public issue author from claiming ownership with copied marker text alone. Other issues and milestones are left alone. It never deletes unrelated resources, reopens a closed issue or milestone, resets a worktree, invokes a shell, or accepts a token/secret as a command-line argument.

The first pass creates or updates managed labels, dated milestones, and issue metadata, linking dependencies whose issue numbers are already known. Once all managed issues are visible, the second pass updates remaining body links and creates missing native GitHub blocked-by relationships using GitHub database IDs. Native relationships are additive: the tool never deletes an existing blocker. Mutations are serialized at an eight-second cadence to stay below GitHub's general content-write budget, with bounded `Retry-After`-aware backoff as a second guard. Re-running an interrupted `apply` resumes from discovered state. A converged rerun therefore produces noops unless the manifest or remote managed state changed.

The pre-v0.1 resource ceilings are part of the issue acceptance criteria: bounded source-file count, per-file and total bytes, archive/materialization size and deadline, and report cardinality/output size. They are release gates, not an invitation to silently truncate analysis.

The roadmap's later adapter, language, local OpenTelemetry import, workspace, and remediation milestones are explicitly gated. If their preceding quality, privacy, security, capacity, or OSS-traction criteria are not met, the work remains deferred and the project spends the milestone on hardening, compatibility, documentation, or maintenance. No public milestone authorizes a required account, source upload, hidden telemetry, or hosted execution path.
