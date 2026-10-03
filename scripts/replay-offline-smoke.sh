#!/usr/bin/env bash
# Build a small bundle from fixtures, then replay it with networking
# disabled. `REPLAY_ISOLATE` prefixes the replay command (CI uses
# `sudo unshare --net --`); without it the replay runs normally.
set -euo pipefail

work="${1:?usage: replay-offline-smoke.sh <work-dir>}"
cli="node dist/cli.js"
mkdir -p "$work"
$cli scan test/fixtures/typescript-fastify >"$work/base.json"
$cli scan test/fixtures/typescript-express >"$work/head.json"
$cli diff-snapshots -f json -o "$work/diff.json" "$work/base.json" "$work/head.json"
$cli bundle create -o "$work/bundle" \
  -a snapshot-base="$work/base.json" \
  -a snapshot-head="$work/head.json" \
  -a diff="$work/diff.json" >/dev/null
# shellcheck disable=SC2086 # REPLAY_ISOLATE is an intentional word list.
${REPLAY_ISOLATE:-} "$(command -v node)" dist/cli.js bundle replay "$work/bundle" >"$work/replay.json"
node -e '
const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const statuses = report.checks.map((check) => `${check.role}:${check.status}`);
if (!report.ok || statuses.join() !== "diff:reproduced") {
  console.error(JSON.stringify(report));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, bundleId: report.bundleId, checks: statuses }));
' "$work/replay.json"
