#!/bin/sh
# One process serves loopback MCP and renews the Digital Post token.
# If the process exits, this script starts it again. It never deletes tokens.
# A rejected refresh leaves the login as login_required; a timeout does not.
set -eu
cd "$(dirname "$0")/.."
restart="${DIGITALPOST_RESTART_SECONDS:-5}"
while true; do
  bun apps/cli/src/index.ts serve --with-renew || true
  echo "digitalpost serve stopped; starting again in ${restart}s" >&2
  sleep "$restart"
done
