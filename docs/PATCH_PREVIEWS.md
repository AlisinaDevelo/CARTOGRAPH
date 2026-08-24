# Isolated patch previews

The `cartograph.patch-preview` v0.1 contract lets a caller inspect a bounded,
digest-guarded text change without modifying the selected repository. The
preview source is a resolved Git commit materialized with `git archive` into a
private temporary tree. The caller's worktree is only read for provenance and
status; it is never checked out, reset, stashed, cleaned, or written.

Each operation names a repository-relative regular file, the SHA-256 digest it
expects at the selected commit, and a bounded replacement string. Paths are
normalized and reject absolute paths, traversal, schemes, and symlinks. A stale
digest, missing target, or unsafe target returns a conflict report and never
applies a partial change to the source tree.

Validation is an explicit allowlist of fixed non-network checks:

- `verify-patch` re-reads every isolated replacement and checks its digest;
- `node-version` runs the current Node executable with `--version`;
- `npm-version` runs the fixed `npm` executable with `--version`.

Repository files cannot select executables, arguments, credentials, or network
behavior. Validation can be explicitly disabled, in which case each requested
check is recorded as `skipped`; disabling validation does not authorize an
application.

Reports include the source ref and commit, request and original-status digests,
dirty-tree provenance, operation before/after digests, validation outcomes, and
rollback instructions. Every report sets `worktreePreserved: true` and
`requiresExplicitApplication: true`. Temporary materialization is cleaned in a
`finally` path. CARTOGRAPH exposes no apply API: any application or rollback is
an explicit user-controlled operation outside the default preview flow.

The checked-in scenarios and schema/runtime validator can be run with:

```sh
npm run patch-preview:validate
```
