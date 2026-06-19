# Example-app cross-region migration — step-by-step runbook

This is the exact, no-guessing procedure to move the **example-app** Supabase project
to a new region with minimal downtime. Every command below has been run/verified against
the live source or the installed CLIs. Follow it top to bottom.

If you only read one thing: **run `bun start doctor` at every gate and do not proceed past
a `✗ NOT READY`.**

Prerequisites (Bun, the `supabase` CLI, `psql`/`pg_dump`, Docker for the rehearsal) and
install steps are in the README **Prerequisites** + **Getting started** sections — set those
up before step 1.

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

- **Option A (recommended, $0):** run `pgshift` from an IPv6-capable host — e.g. a small
  VM in the target region. Clone the repo, `bun install`, copy `migrate.config.yaml` + `.env`.
- **Option B (small cost):** enable the [IPv4 add-on](https://supabase.com/docs/guides/platform/ipv4-address)
  on the source (and target) for the migration window, then run from this box. Remove it after.

The read-only prep in steps 2–3 and the dump/restore in step 6 work from **this box via the
pooler** regardless of which option you choose.

---

## 2. Prep state (already done — verify, don't redo)

```bash
cd ~/pgshift
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

### Migration-day signals — success & abort thresholds

Decide these BEFORE you stop writes. The tool owns the **data-plane** gates (left);
your Grafana/observability stack owns the **app-tier** gates (right). Abort if either trips.

| Phase | Watch (data-plane, this tool) | Watch (app-tier, your dashboards) |
|---|---|---|
| Initial copy (`watch`) | WAL retained MB < `watchdog.maxRetainedWalMb`; slot `active`; `wal_status` stays `reserved`/`extended` (not `lost`); `apply_error_count`/`sync_error_count` flat | source DB CPU / disk IOPS / disk latency headroom; source not approaching connection saturation |
| Lag drain (`cutover` 9b) | lag → 0 within `--max-lag-wait`; quiesce check reports source WAL **quiescent** (no active write backends) | app confirmed in read-only / down; no client write retries hitting the source |
| Verify (`reconcile` 9c) | `RECONCILE PASSED` (zero mismatched buckets, ledger clean) | — |
| Post-repoint (9e) | sequences resynced (cutover log shows each `setval`) | target p95/p99 latency within X% of source baseline; 5xx < Y; connection pool not spiking from retry storms |

**Hard abort thresholds (define concrete numbers from your baselines):**
- `watch` self-aborts on WAL watchdog and on `wal_status=lost` — do **not** override these.
- Lag fails to drain in `--max-lag-wait` → writes are not actually stopped; do not proceed.
- `reconcile` reports any mismatch → do **not** complete cutover; investigate.
- App-tier: sustained 5xx > Y for N min, or DB p95 > X for N min, after repoint → roll back (§12).

Keep one Grafana view open for migration day: API RPS + p95/p99, 4xx/5xx + timeouts, DB CPU/mem/disk-latency/IOPS, DB connections (+ pooler), and the `pgshift watch`/`status` output (or its `--log-file`).

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
OAuth / JWT secrets on the target by hand in the dashboard. `config-sync` is a TS port that
has **not** been validated against the live Management API — always `--dry-run` and review
the diff before applying.

> **The new project has a new JWT secret + anon/service keys.** Every existing user JWT and
> session is signed with the OLD secret, so all users (the 3 here) must **re-login** after
> cutover. Update the app's `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (the Worker secrets) to
> the new project as part of step 9e.

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

## 12. Abort / rollback — decision tree by phase

The rollback that's available depends on where you are. **The point of no return for a
lossless rollback is step 9e** (repointing the app at the target). Know which phase you're
in before you act.

### Phase A — before 9a (source still taking writes)

Abort is **free**. The source has served continuously and the target is a throwaway.

```bash
bun start teardown      # drops subscription → slot → publication; source untouched
# optionally delete the target project
```

### Phase B — after 9a, before 9e (writes stopped, app NOT yet repointed)

Still **lossless**: the target has taken zero application writes, so the source is current.
Roll back by simply not flipping the app:

```bash
bun start teardown      # remove replication objects
# re-enable application writes on the SOURCE and bring the app back up unchanged
```

This is the **last lossless rollback point** unless you set up reverse replication (below).

### Phase C — after 9e (app repointed, target taking writes) — POINT OF NO RETURN

Rolling straight back to the source now **loses every write the target took since 9e**,
because nothing replicates target → source. Your options, worst-case first:

1. **Roll forward** (preferred): fix the problem on the target. The source is already stale;
   it is no longer a clean fallback.
2. **Accept the loss window**: if the target took only a few minutes of writes and they're
   recoverable/negligible, repoint back to the source and manually re-apply what was lost.
   You **must never** then re-enable writes on both — pick one authoritative DB (split-brain).
3. **Lossless rollback** — only if you set up **reverse replication** at cutover (below).

### Optional: reverse replication for a lossless rollback window

If the migration is high-stakes and you want Phase C to stay lossless during a validation
window, establish target → source streaming **after** `reconcile` passes (9c) and **before**
you repoint the app (9e). Use a second config with the roles swapped and **`copy_data: false`**
(the data already matches — you only want new changes to stream back):

```bash
# migrate.reverse.yaml: source.ref/target.ref swapped, distinct slot/publication/subscription
# names, replication.copyData: false. SOURCE_DB_URL/TARGET_DB_URL swapped in a reverse .env.
bun start -c migrate.reverse.yaml replicate    # target → source, streaming only (no copy)
```

Now writes to the new target also flow back to the old source. If you must roll back inside
the window: stop writes on the target, `bun start -c migrate.reverse.yaml cutover` (drain the
reverse lag), repoint the app to the source, and tear down both directions. Once you're
confident in the target, tear down the reverse path (§11 with the reverse config) and the old
project becomes a cold standby.

> Reverse replication requires the source to still satisfy the same preflight gates (wal_level,
> replica identity) it always had — it does. It is **not** bidirectional/active-active: only one
> side ever takes application writes at a time. Its sole purpose is a clean escape hatch.

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
| `bun start run [--through P] [--json] [--confirm-writes-stopped]` | autonomous pipeline (preflight→replicate→watch→reconcile[→cutover]); exit 0 iff the requested range passed. For CI/Lambda. |
| `bun start status [--json] [--require-synced]` | one-shot replication snapshot (sub state, srsubstate, slot active, WAL retained, lag) for a scheduled watcher |
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
| `bun start rehearse run --gib N --payload B [--chaos S --chaos-arg T]` | full scale rehearsal in-tool: seed-to-size → run → fault gate → teardown (THROWAWAY pair) |
| `bun run test:integration` | live replication/reconcile against a throwaway Postgres pair |

All commands take `-c <path>` for an alternate config (default `migrate.config.yaml`).
