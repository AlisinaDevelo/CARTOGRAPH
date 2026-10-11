#!/usr/bin/env bash
# Replay signed fixture bundles through a fresh installed package with
# enforced network isolation. REPLAY_ISOLATE is an executable word list
# (CI uses `sudo unshare --net --`); quoted arguments are not interpreted.
set -euo pipefail

work="${1:?usage: replay-offline-smoke.sh <work-dir>}"
if [[ -z "${REPLAY_ISOLATE:-}" ]]; then
  printf '%s\n' 'REPLAY_ISOLATE is required; replay needs enforced network isolation' >&2
  exit 2
fi
read -r -a isolate <<< "$REPLAY_ISOLATE"
exec "$(command -v node)" "$(dirname "$0")/replay-offline-smoke.mjs" "$work" "${isolate[@]}"
