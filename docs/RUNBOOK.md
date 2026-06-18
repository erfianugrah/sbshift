# Example-app cross-region migration — step-by-step runbook

This is the exact, no-guessing procedure to move the **example-app** Supabase project
to a new region with minimal downtime. Every command below has been run/verified against
the live source or the installed CLIs. Follow it top to bottom.

If you only read one thing: **run `bun start doctor` at every gate and do not proceed past
a `✗ NOT READY`.**

---

## 0. Verified facts about this migration (do not re-derive)

| Fact | Value | Why it matters |
|---|---|---|
| Source project | `example-app`, ref `REDACTED` | the FROM |
| Source region | `eu-central-1` | the move is *away* from here |
| Org | `ExampleOrg`, id `REDACTED` | target must be created here |
| Postgres | 17.6, `wal_level=logical` | logical replication is available |
| Data tables | `public.documents`, `public.aliases` | the only things this tool replicates |
| Data size | ~6 documents, 0 aliases | copy is instant; this is a rehearsal of the big-DB procedure |
| Generated col | `documents.search_vector` (tsvector) | excluded from the reconcile hash automatically |
| **Cross-schema FK** | `public.documents.user_id → auth.users` (3 users) | **auth.users must exist on target BEFORE copy** |
| Sequences (public) | none (uuid PKs) | no sequence resync at cutover |
| Storage | 0 buckets, 0 objects | **skip the storage step entirely** |
| Edge Functions | none (app runs on elsewhere) | **skip the functions step** (`functions.enabled: false`) |
| Realtime publications on public tables | none (broadcast dropped in migration `REDACTED`) | nothing to re-enable for data tables |
| Non-default extensions | `pg_cron`, `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `hypopg`, `index_advisor`, `supabase_vault` | must be enabled on target before schema load |
| Custom LOGIN roles | none (only Supabase-managed roles) | no manual role-password resets needed |

`SUPABASE_GO_BINARY` shim note: this machine needs
`export SUPABASE_GO_BINARY="$HOME/.local/share/supabase/supabase-go"` before any
`supabase` command, or the CLI can't find its Go binary.

---

## 1. DECISION REQUIRED — where you run the replication from (connectivity)

Logical replication needs a **direct** connection on both ends:
`postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres`.
The **pooler** host (`...pooler.supabase.com`) **cannot stream replication** — it is only
usable for read-only inspection and for `supabase db dump`.

The direct host is **IPv6-only** unless the project has the IPv4 add-on. **This dev box has
no IPv6 route**, so `replicate` / `watch` / `reconcile` **cannot run from here**. Pick one
before you go further:

- **Option A (recommended, $0):** run `sbmigrate` from an IPv6-capable host — e.g. a small
  VM in the target region. Clone the repo, `bun install`, copy `migrate.config.yaml` + `.env`.
- **Option B (small cost):** enable the [IPv4 add-on](https://supabase.com/docs/guides/platform/ipv4-address)
  on the source (and target) for the migration window, then run from this box. Remove it after.

The read-only prep in steps 2–3 and the dump/restore in step 6 work from **this box via the
pooler** regardless of which option you choose.

---

## 2. Prep state (already done — verify, don't redo)

```bash
cd ~/supabase-region-migrate
bun install
# migrate.config.yaml and .env are already staged (both gitignored).
#   - migrate.config.yaml: source.ref = REDACTED, target.ref = PENDING…
#   - .env: SOURCE_DB_URL = pooler (for doctor from here), TARGET_DB_URL = placeholder
bun start doctor --source-only
```

Expected: `READY (with warnings)`. The one warning is the `auth.users` cross-schema FK
(addressed in step 6) plus the "pooler endpoint" note (expected from this box).

---

## 3. Rehearse on throwaway Postgres first (optional but recommended, $0)

Proves the replication + reconcile + fault-detection SQL end-to-end with no Supabase project:

```bash
bun run test:integration   # needs Docker; 7 tests, ~6s
```

---

## 4. Create the target project  ← THE ONLY BILLABLE STEP

```bash
export SUPABASE_GO_BINARY="$HOME/.local/share/supabase/supabase-go"

# Pick the new region. Source is eu-central-1; e.g. ap-southeast-1 = Singapore.
# Valid regions: ap-east-1 ap-northeast-1 ap-northeast-2 ap-south-1 ap-southeast-1
#   ap-southeast-2 ca-central-1 eu-central-1 eu-central-2 eu-north-1 eu-west-1 eu-west-2
#   eu-west-3 sa-east-1 us-east-1 us-east-2 us-west-1 us-west-2
supabase projects create example-app-<region> \
  --org-id REDACTED \
  --region <TARGET_REGION> \
  --db-password "$(openssl rand -base64 24)"   # SAVE THIS — you'll need it below
```

Note the new project **ref** it prints. From the dashboard **Connect** panel of the new
project, copy the **direct** connection string (`db.<newref>.supabase.co:5432`) and its
**session-pooler** string (`...pooler.supabase.com:5432`) — you'll use the pooler for the
restore and the direct one for replication.

---

## 5. Point the config + env at the new target

Edit `migrate.config.yaml`:

```yaml
target:
  ref: <NEW_TARGET_REF>
```

Edit `.env` — set `TARGET_DB_URL` to the new project's **direct** string, and (only when you
run replication from an IPv6 host or with the IPv4 add-on) switch `SOURCE_DB_URL` to the
source **direct** string. From this box keep `SOURCE_DB_URL` on the pooler for the dump.

---

## 6. Restore everything the tool does NOT replicate — onto the target, in order

Logical replication carries **table rows only** — no DDL, no roles, no `auth`/`storage`
schemas. The FK `documents.user_id → auth.users` means the **3 auth users must exist on the
target before the copy**, or every `documents` row is rejected. Connection here can be the
**pooler** (read for dump, write for restore) — direct is not required for this step.

```bash
export SUPABASE_GO_BINARY="$HOME/.local/share/supabase/supabase-go"
SRC="postgresql://postgres.REDACTED:<SRC_PW>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
TGT="postgresql://postgres.<NEW_TARGET_REF>:<TGT_PW>@<TGT_POOLER_HOST>:5432/postgres"

# 6a. dump roles, schema (DDL+RLS+functions), and the auth-schema DATA from the source
supabase db dump --db-url "$SRC" -f roles.sql  --role-only
supabase db dump --db-url "$SRC" -f schema.sql
supabase db dump --db-url "$SRC" -f auth.sql   --data-only --schema auth --use-copy

# 6b. enable non-default extensions on the target FIRST (dashboard → Database → Extensions,
#     or SQL). `doctor` in step 7 will tell you exactly which are still missing; enable those.
#     For example-app the set is: pg_cron pgcrypto uuid-ossp pg_stat_statements hypopg
#     index_advisor supabase_vault  (several are enabled automatically by schema.sql).

# 6c. restore roles → schema → auth data, with triggers disabled during the data load
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file auth.sql \
  --dbname "$TGT"
```

If `psql` errors on `supabase_admin` ownership or the `cli_login_postgres` grant, see the
"Troubleshooting" notes in the upstream guide
(`/docs/supabase/guides/platform/migrating-within-supabase/backup-restore.md`) — comment out
the offending `ALTER ... OWNER TO "supabase_admin"` / `GRANT "postgres" TO "cli_login_postgres"`
line and re-run.

`schema.sql` is the authoritative app-schema source here (full live DDL: tables, RLS,
functions, the `pg_cron`/cleanup functions). It does **not** contain the `cron.schedule(...)`
job row (that's data in the `cron` schema, not DDL), so the target won't run cleanup jobs
while both DBs are live. You add that one schedule explicitly **after** cutover in step 9d.
Do not apply the document-store migrations dir here — `schema.sql` already captures the live state.

---

## 7. Full readiness check + preflight  ← GATE (run from the replication host)

```bash
bun start doctor        # full: source + target
bun start preflight
```

`doctor` must end `READY` (warnings ok). It will confirm: target reachable, target version ≥
source, target role can `CREATE SUBSCRIPTION`, **target has all source extensions**, **target
tables `public.documents`/`public.aliases` exist (schema loaded)**, and that `auth.users` is no
longer flagged as missing prerequisite data. **Stop if any `✗`.**

---

## 8. Stand up replication and watch the initial copy  ← DIRECT connection required

```bash
bun start replicate     # creates publication + slot on source, subscription on target
bun start watch         # polls until all tables srsubstate='r'; aborts if WAL bloats past
                        # watchdog.maxRetainedWalMb (2048) on the source
```

`replicate` is idempotent-ish: it skips objects that already exist. If you need to start
over, run `bun start teardown` first.

---

## 9. Cutover  ← brief downtime starts here

```bash
# 9a. STOP application writes to the SOURCE (put the app in read-only / take it down).
#     This is the only moment of downtime.

# 9b. drain replication lag to zero and drop the subscription:
bun start cutover                     # default waits up to 300s for lag to drain
#   (override: bun start cutover --max-lag-wait 600)

# 9c. verify source == target:
bun start reconcile                   # chunked checksum; must print RECONCILE PASSED
#   (full-table variant: bun start reconcile --mode full)

# 9d. now load the pg_cron schedule migration on the TARGET (the one skipped earlier):
psql "$TARGET_DB_URL" -f path/to/supabase/migrations/REDACTED_scheduled_jobs.sql

# 9e. repoint the app: set the Worker's SUPABASE_URL / SUPABASE_SECRET_KEY to the new
#     project and redeploy. DNS/edge cutover as applicable.
```

**Never re-enable writes on the source after this point** — that causes split-brain. The
`cutover` command prints the same warning.

---

## 10. Copy non-data config (secrets stripped)

```bash
bun start config-sync --dry-run   # review the diff first
bun start config-sync
```

This copies Auth / Realtime / PostgREST / Storage / pooler settings via the Management API
(needs `SUPABASE_ACCESS_TOKEN` in `.env`). **Secrets are never copied** — re-enter SMTP /
OAuth / JWT secrets on the target by hand in the dashboard.

For example-app specifically:
- **Storage** objects: none → skip (`supabase storage` step not needed).
- **Edge Functions**: none → skip (`functions.enabled: false`).
- **OAuth**: re-enter the OAuth client id/secret on the target's Auth providers.

---

## 11. Tear down replication objects

```bash
bun start teardown      # drops subscription → slot → publication, in the safe order
```

---

## 12. Abort / rollback (before cutover only)

If anything looks wrong **before step 9a** (you have not stopped source writes yet):

```bash
bun start teardown      # removes the subscription/slot/publication; source is untouched
```

The source keeps serving the whole time up to cutover, so aborting pre-cutover is free —
just tear down and optionally delete the target project. After cutover (9a), rolling back
means pointing the app back at the source **only if** you have not taken writes on the
target; once the target has taken writes, the source is stale and you must reconcile
forward, not back.

---

## 13. Post-migration verification

- `bun start reconcile` → `RECONCILE PASSED`.
- App health: create a document, view it, confirm it persists on the new project.
- Confirm `auth` login still works (the 3 migrated users) via OAuth.
- Confirm pg_cron jobs are scheduled on the target (`select * from cron.job;`).
- Leave the old project paused (not deleted) for a few days as a safety net.

---

## Command reference (this tool)

| Command | What it does |
|---|---|
| `bun start doctor [--source-only]` | automated readiness checklist (connection shape, reachability, wal_level, replica identity, reconcile hashColumns ↔ live schema, cross-schema FK deps, target version/grant/extensions/schema-loaded) |
| `bun start preflight` | read-only hard-gate checks; throws on failure |
| `bun start replicate` | publication + slot + subscription (starts initial copy) |
| `bun start watch` | poll initial-sync state + WAL-bloat watchdog |
| `bun start reconcile [--mode chunked\|full] [--buckets N] [--max-examples N]` | checksum source vs target |
| `bun start cutover [--max-lag-wait SEC]` | drain lag to 0, drop subscription |
| `bun start teardown` | drop subscription/slot/publication safely (idempotent) |
| `bun start config-sync [--dry-run]` | copy non-data config via Management API (secrets stripped) |
| `bun start functions [--dry-run]` | transfer Edge Functions (N/A for example-app) |
| `bun start storage <localDir> [--dry-run]` | push storage objects (N/A for example-app) |
| `bun run test:integration` | live replication/reconcile against a throwaway Postgres pair |

All commands take `-c <path>` for an alternate config (default `migrate.config.yaml`).
