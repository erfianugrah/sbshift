#!/usr/bin/env bash
# Run the live integration tier against a throwaway Postgres pair, one command.
#
#   bun run test:integration
#
# Stands up source (wal_level=logical) + target + a bun runner on a shared
# compose network, runs test/integration.test.ts inside the network, and tears
# the whole thing down afterwards. The process exit code is the test exit code.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker compose version >/dev/null 2>&1; then
  echo "error: 'docker compose' is not available." >&2
  echo "  On Docker Desktop + WSL, enable the WSL integration for this distro" >&2
  echo "  (Settings → Resources → WSL Integration), then re-run." >&2
  exit 127
fi

COMPOSE=(docker compose -f docker-compose.test.yml)

cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ starting throwaway Postgres pair (source wal_level=logical) + bun runner"
"${COMPOSE[@]}" up \
  --abort-on-container-exit \
  --exit-code-from runner \
  runner
