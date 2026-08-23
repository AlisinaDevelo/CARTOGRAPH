# CARTOGRAPH managed roadmap

`manifest.json` is the managed roadmap source for CARTOGRAPH's public GitHub milestones, labels, and issues. Keep the manifest reviewable in this repository; do not hand-edit generated GitHub issue text as a substitute for changing the manifest.

The manifest deliberately contains sequence-based milestones (`Year 1 Q1` through `Year 3 Q4`) rather than calendar dates. Each issue has a stable ID, a problem/outcome statement, measurable acceptance criteria, dependencies, labels, priority, milestone, and an explicitly open default state.

## Local commands

From the repository root:

```text
node scripts/github-roadmap.mjs validate
node --test roadmap/github-roadmap.test.mjs
node scripts/github-roadmap.mjs plan --repo OWNER/REPO
node scripts/github-roadmap.mjs apply --repo OWNER/REPO --confirm
```

`validate` is fully offline. `plan` reads the repository's current labels, milestones, and issues through the GitHub CLI (`gh`) and emits create/update/noop operations without writing. `apply` is the only mutating command and requires the explicit `--confirm` flag; it uses rate-spaced `gh api` calls with argument arrays, stable HTML markers, a bounded post-write verification retry for eventual visibility, and a second pass to replace dependency IDs with issue links. Marker, duplicate, and ownership collisions remain fail-closed.

The CLI manages only configured label names, marked milestones, and marked issues already bound to one of those managed milestones. That milestone binding prevents a public issue author from claiming ownership with copied marker text alone. Other issues and milestones are left alone. It never deletes unrelated resources, resets a worktree, invokes a shell, or accepts a token/secret as a command-line argument.

The first pass creates or updates managed labels, milestones, and issue metadata, linking dependencies whose issue numbers are already known. Once the first pass has created any forward dependencies, the second pass updates only the remaining managed issue bodies so those IDs become links. Re-running `apply` should therefore produce noops unless the manifest or remote managed state changed.

The pre-v0.1 resource ceilings are part of the issue acceptance criteria: bounded source-file count, per-file and total bytes, archive/materialization size and deadline, and report cardinality/output size. They are release gates, not an invitation to silently truncate analysis.

The roadmap's later adapter, language, OpenTelemetry, and hosted/team milestones are explicitly gated. If their preceding quality, privacy, or OSS-traction criteria are not met, the work remains deferred and the project spends the milestone on hardening, compatibility, documentation, or maintenance.
