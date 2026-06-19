#!/usr/bin/env bash
# End-to-end pgshift validation against a REAL throwaway Supabase project pair.
#
#   SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/live-supabase-test.sh <org-id> [rows]
#
# Creates two throwaway projects (source + target, cross-region), loads a
# deliberately annoying schema on both, seeds the source, runs the full pgshift
# pipeline (doctor → preflight → replicate → watch → reconcile → cutover), proves
# the resynced sequence prevents a post-cutover id collision, then DELETES both
# projects. One command, repeatable, self-tearing-down — no manual psql.
#
# Designed to run from a host WITHOUT IPv6 to the direct hosts: admin/seed/
# reconcile go through the IPv4 session pooler, and the subscription streams via
# SOURCE_REPLICATION_URL (the source direct host, reached by the target's
# walreceiver over Supabase's internal network). See README "Direct connection".
#
# Costs real money while the projects exist (minutes). The trap tears them down
# on any exit. Requires: curl, psql, bun, python3, openssl, SUPABASE_ACCESS_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

ORG="${1:?usage: live-supabase-test.sh <org-id> [rows]}"
ROWS="${2:-50000}"
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN (sbp_...)}"
API=https://api.supabase.com/v1
SRC_REGION="${SRC_REGION:-eu-central-1}"
TGT_REGION="${TGT_REGION:-eu-west-1}"
SRC_PW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)
TGT_PW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)
SRC_REF="" ; TGT_REF=""

say() { printf '\n\033[36m== %s\033[0m\n' "$*"; }

create_project() { # name region pw -> echoes ref
  curl -sS -m 30 -X POST "$API/projects" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"organization_id\":\"$ORG\",\"db_pass\":\"$3\",\"region\":\"$2\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['ref'])"
}

pooler() { # ref -> "host user" (session pooler, port 5432)
  curl -sS -m 20 "$API/projects/$1/config/database/pooler" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  | python3 -c "import sys,json;d=json.load(sys.stdin)[0];print(d['db_host'],d['db_user'])"
}

wait_healthy() { # ref...
  for _ in $(seq 1 60); do
    local all=1
    for ref in "$@"; do
      s=$(curl -sS -m 20 "$API/projects/$ref" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
          | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))" 2>/dev/null || echo ERR)
      [ "$s" = ACTIVE_HEALTHY ] || all=0
    done
    [ "$all" = 1 ] && return 0
    sleep 15
  done
  echo "timed out waiting for ACTIVE_HEALTHY" >&2; return 1
}

teardown() {
  say "TEARDOWN — deleting throwaway projects"
  for ref in "$SRC_REF" "$TGT_REF"; do
    [ -n "$ref" ] && curl -sS -m 30 -X DELETE "$API/projects/$ref" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" >/dev/null 2>&1 \
      && echo "deleted $ref" || true
  done
}
trap teardown EXIT

say "creating projects (src=$SRC_REGION tgt=$TGT_REGION)"
SRC_REF=$(create_project pgshift-livetest-src "$SRC_REGION" "$SRC_PW")
TGT_REF=$(create_project pgshift-livetest-tgt "$TGT_REGION" "$TGT_PW")
echo "src=$SRC_REF tgt=$TGT_REF"

say "waiting for both ACTIVE_HEALTHY (provisioning ~2-4 min)"
wait_healthy "$SRC_REF" "$TGT_REF"
# pooler/postgres needs a few more seconds to accept conns after healthy
sleep 20

read -r SRC_POOL_HOST SRC_POOL_USER < <(pooler "$SRC_REF")
read -r TGT_POOL_HOST TGT_POOL_USER < <(pooler "$TGT_REF")
SRC_POOL="postgresql://${SRC_POOL_USER}:${SRC_PW}@${SRC_POOL_HOST}:5432/postgres?sslmode=require"
TGT_POOL="postgresql://${TGT_POOL_USER}:${TGT_PW}@${TGT_POOL_HOST}:5432/postgres?sslmode=require"

say "loading annoying schema on both (via pooler)"
psql "$SRC_POOL" -v ON_ERROR_STOP=1 -q -f scripts/annoying-schema.sql
psql "$TGT_POOL" -v ON_ERROR_STOP=1 -q -f scripts/annoying-schema.sql

say "seeding source ($ROWS documents + deps)"
psql "$SRC_POOL" -v ON_ERROR_STOP=1 -q -v rows="$ROWS" -f scripts/annoying-seed.sql
psql "$SRC_POOL" -q -c "select 'users' t,count(*) from public.users union all select 'documents',count(*) from public.documents union all select 'events',count(*) from public.events union all select 'audit',count(*) from public.audit"

# pooler for admin/seed/reconcile; subscription streams from the source direct host
export SOURCE_DB_URL="$SRC_POOL"
export TARGET_DB_URL="$TGT_POOL"
export SOURCE_REPLICATION_URL="postgresql://postgres:${SRC_PW}@db.${SRC_REF}.supabase.co:5432/postgres?sslmode=require"

CFG=migrate.livetest.yaml
sed -e "s/__SRC_REF__/$SRC_REF/" -e "s/__TGT_REF__/$TGT_REF/" scripts/live-config.template.yaml > "$CFG"

say "pgshift doctor"     ; bun run src/cli.ts -c "$CFG" --no-log-file doctor
say "pgshift preflight"  ; bun run src/cli.ts -c "$CFG" --no-log-file preflight
say "pgshift replicate"  ; bun run src/cli.ts -c "$CFG" --no-log-file replicate
say "pgshift watch"      ; bun run src/cli.ts -c "$CFG" --no-log-file watch
say "pgshift reconcile"  ; bun run src/cli.ts -c "$CFG" --no-log-file reconcile
say "pgshift cutover"    ; bun run src/cli.ts -c "$CFG" --no-log-file cutover

say "post-cutover sequence-collision check (must return ROWS+1)"
NEWID=$(psql "$TGT_POOL" -tA -c "INSERT INTO public.documents (content) VALUES ('post-cutover') RETURNING id")
echo "new document id on target: $NEWID (expected $((ROWS + 1)))"
[ "$NEWID" = "$((ROWS + 1))" ] && echo "✓ sequence resync prevented collision" \
  || { echo "✗ sequence collision — resync failed"; exit 1; }

rm -f "$CFG"
say "LIVE TEST PASSED — pipeline clean end-to-end against real Supabase"
# teardown runs on EXIT
