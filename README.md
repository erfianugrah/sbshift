# pgshift

Typed CLI orchestrator for **near-zero-downtime Postgres-to-Postgres migration** via native
logical replication — for the large-database case where a plain dump/restore window is
unacceptable.

The engine — `replicate → watch → reconcile → cutover → teardown` — is **generic Postgres**
(publication + slot + subscription, catalog-driven monitoring, checksum reconciliation,
lag-drain + sequence resync). It works for any PG15+ → PG15+ pair: Supabase↔Supabase (any
region, or same region for a tier change / project split), self-hosted↔Supabase, or
self-hosted↔self-hosted. When both ends are Supabase, **optional** commands wrap the official
`supabase` CLI + Management API for the non-replicated pieces (schema dump, storage, edge
functions, project config) instead of reimplementing them; they no-op or are skippable for
non-Supabase migrations.

It owns the one piece nothing else automates: the **data-replication state machine +
reconciliation + WAL watchdog**.

## Why this exists

A cross-region migration is ~7 independent workstreams. Most are already covered; this tool
fills the data-movement gap and reminds you of the rest:

| Workstream | Handled by | In this tool |
|---|---|---|
| Schema / DDL | `supabase db push` / `pg_dump --schema-only` | you run it (see runbook) |
| **Table data, low-downtime** | native logical replication | **`replicate` + `watch`** |
| Sequences | `pg_dump --data-only --table='*_seq'` | `cutover` reminds you (N/A for uuid PKs) |
| Storage objects | `supabase storage cp` | `storage` wrapper |
| Edge Functions | `supabase functions download/deploy` | `functions` wrapper |
| Project config (Auth/Realtime/…) | Management API | **`config-sync`** (TS port, secrets stripped) |
| Secrets (SMTP/OAuth/JWT/…) | nothing — manual by design | flagged, never copied |

## When this tool does NOT apply

Logical replication streams **live WAL**, so the source must be running with
`wal_level=logical`. A **paused** project — especially one paused **> 90 days** (no longer
restorable via Studio) — cannot stream WAL. That's a wrong-tool condition, not an in-flight
hazard: use Supabase's offline path instead — download the database backup + Storage objects
from Project Overview and restore them into a new project
([Restore project after 90-day pause](https://supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause)).
That path reuses the same building blocks this tool wraps (`supabase storage cp` for objects,
the Management-API config copy that `config-sync` is a TS port of), so `config-sync`,
`functions`, and `storage` here remain useful even on the backup-restore route.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.3 | runs the CLI directly from TypeScript — **no build step**. `bin` in `package.json` points at `src/cli.ts`. Node.js is **not** supported. |
| `supabase` CLI | ≥ 2.x | `config-sync`, `functions`, `storage`, and the auth/roles/schema dump-restore pre-step |
| `psql` + `pg_dump` | ≥ 15 (match the source major, e.g. 17) | restoring roles/schema/auth onto the target; loading migrations |
| Docker + `docker compose` | v2 | **only** for the rehearsal harness and `test:integration` — not for a real migration |

The replication host must reach the **direct** Postgres hosts (IPv6, or the IPv4 add-on) — see
the connection note below. Runtime deps (via `bun install`): `commander`, `postgres`, `yaml`,
`zod`. Dev: `@biomejs/biome`, `typescript`, `@types/bun`.

## Getting started

```bash
git clone https://github.com/erfianugrah/pgshift.git && cd pgshift
bun install                                           # commander, postgres, yaml, zod
cp migrate.config.example.yaml migrate.config.yaml    # set source/target refs + tables
cp .env.example .env                                  # DIRECT connection strings + PAT

bun start doctor --source-only                        # verify readiness (no target needed yet)
```

Secrets live only in `.env` (connection strings, access token); the YAML is non-secret and
commit-safe. Then follow **[`docs/RUNBOOK.md`](docs/RUNBOOK.md)**.

Development commands:

```bash
bun test                  # unit suite (fast, no DB)
bun run test:integration  # live replication/reconcile vs a throwaway Postgres pair (needs Docker)
bun run test:scale        # 1M-row stress harness (needs Docker); WRITE_LOAD / negative modes below
bun run test:live <org>   # end-to-end against real throwaway Supabase projects (costs money)
bun run typecheck         # tsc --noEmit
bun run check             # biome format + lint
```

### Connection: direct vs pooler (the IPv6 trap)

Both ends need a **direct** connection (`db.<ref>.supabase.co:5432`) — the pooler
(`*.pooler.supabase.com`) **cannot stream logical replication**. The direct host is
**IPv6-only** unless the project has the
[IPv4 add-on](https://supabase.com/docs/guides/platform/ipv4-address).

If the box you run `pgshift` from has no IPv6 route, you have two options: run it from a host
that does (a VM in the target region is ideal), or **split the connection** — point
`SOURCE_DB_URL`/`TARGET_DB_URL` at the IPv4 **session pooler** (port 5432) for
admin/seed/reconcile and set **`SOURCE_REPLICATION_URL`** to the source *direct* host. The
subscription then streams from there (the target's walreceiver reaches it over Supabase's
internal network) while the pooler can't stream WAL. `doctor` classifies each URL and validates
the split. *Verified live: the full pipeline — including `CREATE SUBSCRIPTION` through the
session pooler — ran end-to-end from a non-IPv6 box against a real cross-region Supabase pair.*

## What this tool does NOT replicate — do this FIRST

Logical replication moves **row data for the tables you list**, and nothing else: no DDL, no
roles, no sequences-as-DDL, no Supabase-managed `auth` / `storage` schemas. For a
Supabase→Supabase move you must restore those onto the target **before** `replicate`, or the
initial copy fails — any FK from a replicated table into `auth.users` rejects every row while
the target's `auth.users` is empty. `doctor` flags any such cross-schema FK.

The Supabase-blessed dump/restore (see
[Migrating within Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore))
covers exactly the parts this tool skips:

```bash
# from the SOURCE (direct or session-pooler connection string)
supabase db dump --db-url "$SOURCE_DB_URL" -f roles.sql  --role-only
supabase db dump --db-url "$SOURCE_DB_URL" -f schema.sql                 # DDL: tables, RLS, functions
supabase db dump --db-url "$SOURCE_DB_URL" -f auth.sql   --data-only --schema auth   # the 3 users etc.

# on the TARGET, in order: roles -> schema -> auth data (triggers off during data load)
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file auth.sql --dbname "$TARGET_DB_URL"
```

Also enable any **non-default extensions** on the target first — `doctor` diffs source vs
target extensions and lists the missing ones.

## What's baked in (so you don't relearn it at 2am)

The reason to use this over hand-rolled SQL: the failure modes below are already handled. Each
is grouped by the command that owns it.

### Safety gates the tool enforces

- **`preflight`** hard-fails before anything is touched on: a published table lacking a
  PK / unique index / `REPLICA IDENTITY FULL`; a target role that can't `CREATE SUBSCRIPTION`
  (documented-supported, but verified). It *warns* on under-provisioned capacity — source
  `max_replication_slots` / `max_wal_senders` headroom, and subscriber `max_worker_processes`
  / `max_logical_replication_workers` (the managed-Postgres footgun; see Azure below).
- **`watch`** turns the silent failure modes loud:
  - **WAL bloat — the #1 outage** → aborts if the slot retains more than
    `watchdog.maxRetainedWalMb` on the source.
  - **Slot invalidation is unrecoverable** → if the source recycles WAL the subscriber never
    read (`max_slot_wal_keep_size` exceeded), `wal_status` flips to `lost` and replication is
    permanently dead. `watch` throws immediately on `wal_status=lost` (rather than spinning)
    and warns as it leaves `reserved`/`extended`.
  - **A stuck subscription fails silently** → an apply/tablesync worker that error-loops
    (constraint violation, type mismatch, conflict) leaves a table below `srsubstate='r'`
    forever. `watch` reads `pg_stat_subscription_stats` and warns when
    `apply_error_count`/`sync_error_count` are *rising*, and when the subscription has **no
    running worker** (`pid` null = disabled/crashed).
  - **A transient blip won't kill a multi-hour watch** → tolerates up to 5 *consecutive*
    transient poll errors (the server-side copy keeps running); deliberate aborts (slot lost,
    WAL watchdog, sync timeout) always propagate immediately.
- **`cutover`** verifies writes are actually stopped → it samples the source WAL LSN twice and
  counts active write-shaped client backends; if WAL is still advancing it warns loudly that
  draining to lag=0 may never finish and post-cutover writes will be lost. (Autovacuum moves
  WAL too, so it's a strong signal, not a hard stop — stop your app's writes first.)
- **`reconcile`** only trusts a drained slot → reconciling while the source still has
  un-replicated in-flight rows yields spurious `missing_on_target` diffs, so it checks the
  slot's un-confirmed WAL and warns if lag > 0 (run it post-cutover). Long table scans use
  `withRetry`, which retries only connection-shaped errors (`08xxx`/`57P0x` SQLSTATEs +
  connection messages), never SQL errors.
- **`doctor`** catches the structural traps → the cross-schema `auth.users` FK (its data must
  exist on the target before the copy), and a published table missing from
  `pg_subscription_rel` (added to the publication after the subscription existed = silently not
  replicating; re-run `replicate` to `REFRESH PUBLICATION`).

### Postgres realities it handles for you

- **`FOR ALL TABLES` needs superuser** → always creates an empty publication and `ADD TABLE`
  explicitly.
- **`copy_data = true`** → the subscription does a consistent initial copy; no fragile
  `pg_dump --snapshot` dance (a SQL-created slot can't export a snapshot anyway).
- **Generated columns** (e.g. a STORED `tsvector`) are **excluded from the reconciliation
  hash** (hashing them causes false mismatches) and are **not free during the initial copy** —
  recomputed per row on the subscriber, so a heavy one CPU-bottlenecks the copy. Measured:
  **~11 MiB/s with the gen-column vs ~80 MiB/s raw seed (~7× slower)**. For very large ones,
  define them as plain on the target during sync and convert to generated *after* the copy, or
  budget the hours. `watch` shows a live copy `%`.
- **Logical replication does NOT carry sequence values** → after the copy a serial/identity
  sequence is stuck at its post-schema-load value, so the next insert collides with a
  replicated row. `cutover` discovers every sequence `OWNED BY` a replicated column (serial
  *and* `IDENTITY`), reads its final value on the write-stopped source, and `setval`s it on the
  target. No-op for uuid/text PKs.
- **Teardown order** → disable → `SET (slot_name = NONE)` → drop subscription → drop slot →
  drop publication, or it hangs. `teardown` does this in order, idempotently.
- **Stable reconcile hash across regions** → row hashes render `row::text`, which depends on
  `TimeZone`/`DateStyle`/`IntervalStyle`/`extra_float_digits`/`bytea_output`. Since source and
  target are different projects, every connection in both pools pins these GUCs identically
  (and sets `statement_timeout=0` so a multi-minute full-table scan isn't killed).

### Your calls (the tool can't make them)

- **Never re-enable writes on the source after cutover** (split-brain) — `cutover` says so.
- **Rollback has a point of no return** → lossless before you repoint the app (step 9e); after
  that, rolling back to the source loses every write the target took. `docs/RUNBOOK.md` §12 has
  the per-phase decision tree + an optional reverse-replication escape hatch.
- **Define abort thresholds before cutover** → the tool owns the data-plane gates (WAL
  watchdog, lag-drain deadline, `reconcile` verdict, apply-error count); your dashboards own the
  app-tier gates (5xx, p95, connection saturation). `docs/RUNBOOK.md` §9 maps both.
- **New project = new JWT secret + API keys** → existing user sessions/JWTs invalidate (users
  re-login) and the app's `SUPABASE_URL` + anon/service keys change. `config-sync` copies
  settings but **never secrets** — re-enter them by hand, and always `--dry-run` first to
  confirm the API shapes before applying.

## Runbook

**Full step-by-step: [`docs/RUNBOOK.md`](docs/RUNBOOK.md)** — the connectivity decision, the
auth/roles/extensions dump-restore pre-step, the billable target-creation step, and
abort/rollback. The block below is the quick reference.

```bash
# 0a. readiness checklist — connection shape (pooler vs direct), reachability,
#     wal_level, replica identity, reconcile hashColumns ↔ live schema, stale
#     slots, row counts, and (when it exists) the target's grant + schema.
#     Tolerant of a not-yet-created target; add --source-only to skip it.
bun start doctor --source-only

# 0b. read-only sanity — versions, wal_level, subscribe grant, replica identity
bun start preflight

# 1. on the TARGET first (logical replication does NOT carry DDL):
#    a) enable non-default extensions (see "What this tool does NOT replicate")
#    b) restore roles + schema + auth/storage DATA via dump/restore (auth.users
#       must exist before the copy or the FK into auth.users rejects every row)
#    c) load app schema. Skip the pg_cron schedule migration so the target
#       doesn't run cleanup independently while both DBs are live:
for f in $(ls path/to/supabase/migrations/*.sql | grep -v scheduled_jobs); do
  psql "$TARGET_DB_URL" -f "$f"
done

# 2. stand up replication (publication + slot + subscription; starts initial copy)
bun start replicate

# 3. watch the initial sync + WAL watchdog until all tables are 'ready'
bun start watch

# 4. (rehearsal) prove no loss under live write load — see Testing & rehearsal below

# 5. CUTOVER: stop app writes to the source, then:
bun start cutover            # drains lag to 0, drops the subscription
#    repoint your app to the target; add cron jobs on the target now.

# 6. copy non-data config (secrets stripped — re-enter SMTP/OAuth/JWT by hand)
bun start config-sync --dry-run   # review the diff
bun start config-sync

# 7. teardown replication objects
bun start teardown
```

## Autonomous runs (CI / Lambda / cron)

The orchestration lives in the tool, not a wrapper script. `run` executes the pipeline
end-to-end with machine-readable output and a meaningful exit code; `status` is a one-shot
health snapshot for a scheduled watcher.

```bash
# one command, non-interactive; exit 0 iff preflight+replicate+watch+reconcile all pass
bun start run --through reconcile --json

# cutover is destructive and REFUSED unless you assert source writes are stopped:
bun start run --through cutover --confirm-writes-stopped

# poll-once snapshot for a watcher; --require-synced exits non-zero until ready:
bun start status --json
bun start status --require-synced    # use in a wait loop
```

With `--json`, `run` emits NDJSON on stdout (`phase_start` / `phase_end` / `summary`) while
human logs go to stderr, so stdout stays parseable. Example GitHub Action (the runner must
reach the **direct** hosts — IPv6 or the IPv4 add-on):

```yaml
name: migrate
on: { workflow_dispatch: {} }
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun start run --through reconcile --json
        env:
          SOURCE_DB_URL: ${{ secrets.SOURCE_DB_URL }}
          TARGET_DB_URL: ${{ secrets.TARGET_DB_URL }}
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```

## Non-Supabase migrations

The replication engine is plain Postgres — the integration suite runs it against vanilla
`postgres:16` containers with zero Supabase involvement. To migrate any PG15+ → PG15+ pair
(self-hosted↔self-hosted, self-hosted↔Supabase, same-region tier change, project split):

- **Required, as always:** source has `wal_level=logical`; the target role can
  `CREATE SUBSCRIPTION`; the schema (DDL) is loaded on the target first; connection strings are
  **direct** (not a transaction pooler).
- **Use:** `doctor`, `preflight`, `replicate`, `watch`, `reconcile`, `cutover`, `teardown`,
  `status`, `run` — all engine-only and Supabase-agnostic.
- **Skip:** `config-sync` (no-ops without `SUPABASE_ACCESS_TOKEN`), `functions`
  (`functions.enabled: false`), `storage` (`storage.buckets: []`). Use ordinary
  `pg_dump`/`pg_dumpall` for the roles/schema/extension pre-steps.
- `doctor`'s Supabase host heuristics (pooler-vs-direct, IPv6, the `auth.users` trap) degrade
  to no-ops on a plain host; the wal_level / replica-identity / version / `CREATE SUBSCRIPTION`
  / schema-loaded / extension-diff checks all still run. Config defaults
  (`replication.slot`/`publication`/`subscription`) are generic names — set them per env.

### Azure Database for PostgreSQL (Flexible Server)

Flexible Server is plain Postgres 11–17, so it works as a source or target with **no code
changes** — Microsoft's own minimal-downtime upgrade guide uses the exact
`publication → slot → subscription` flow this tool automates. Azure-specific prerequisites
(surfaced by `doctor`/`preflight` where checkable):

- **Server parameters** (portal → Server parameters, then restart): `wal_level=logical`, and on
  the **subscriber** `max_worker_processes >= 16` — Azure ships a low default and logical
  apply/table-sync run as background workers, so too few stalls the subscription with
  `out of background worker slots`. Bump `max_replication_slots` / `max_wal_senders` on the
  source above the slot count you'll run. `preflight` warns on all of these.
- **Replication role:** `ALTER ROLE <user> WITH REPLICATION;` — and if it isn't the
  server-admin account, also `GRANT azure_pg_admin TO <user>;` (plus `LOGIN`).
- **Network:** the target's walreceiver must reach the source's direct host:5432 (firewall rule
  / allowed Azure region IP ranges) — same reachability constraint as any direct-connection
  pair.
- **Unused-slot auto-drop:** at ≥95% storage (or <5 GiB free) Azure flips the server read-only
  and **drops idle logical slots** to release WAL — a platform backstop on top of `watch`'s own
  watchdog. Don't leave a slot without a live subscriber.
- **HA-enabled source:** before PG17, logical slots are **not** preserved across an HA failover
  (needs the PG Failover Slots extension; PG17 has native slot sync). Expect to restart
  replication after a failover.

> **Not** Azure SQL Database / Managed Instance — that's the SQL Server engine (T-SQL), a
> heterogeneous migration with no Postgres logical replication. Different tool class entirely
> (Azure DMS / schema conversion); out of scope here.

## Testing & rehearsal

Four validation tiers. The **first two run in CI** (`.github/workflows/ci.yml`: the `test` job
runs the unit tier; the `integration` job runs the integration tier **and** the scale harness's
three safety-gate modes under Docker). The scale and live harnesses are the other two.

```bash
bun test                  # 1. unit       — pure logic, no DB, always runs
bun run test:integration  # 2. integration — live replication + fault injection vs a Docker PG pair
bun run test:scale        # 3. scale      — volume + safety-gate harness (Docker)
bun run test:live <org>   # 4. live       — real throwaway Supabase projects (costs money)
```

**Unit** (the `test` CI job): zod config parsing + identifier/SQL-injection guards, config-sync
secret stripping, bucket-diff classification, conn-string builder.

**Integration** (the `integration` CI job, via `scripts/test-integration.sh`): stands up two
ephemeral `postgres:16` containers (source `wal_level=logical`) plus a bun runner **on one
compose network**, runs `test/integration.test.ts`, and tears it all down. It asserts each fault
is caught: happy-path reconcile clean, `lose-row` → reconcile fails, `corrupt-row` → reconcile
fails, generated column excluded (clean data still reconciles), `drop-replica-identity` →
`preflight` rejects.

> **Why a shared network, not two bare `docker run`s with `localhost`:** `replicate.ts` uses one
> connection string both for its own libpq connection and as the subscription's `CONNECTION`,
> which the *target's* walreceiver dials. With `localhost:5432` the target resolves `localhost`
> to itself, not the source. On a compose network the subscription uses the service-DNS name
> `source:5432`, which resolves identically from runner and target. To point the tier at your
> own pair, set `TEST_SOURCE_DB_URL` + `TEST_TARGET_DB_URL` (both reachable under the *same* name
> from wherever the target runs); without them and without the compose harness, the tier
> self-skips so a bare `bun test` stays green on the unit tier alone.

### Rehearsal — prove it at real scale on a throwaway pair

Theory passing at 1M rows proves nothing — the failures that matter (slow initial copy holding
the slot, WAL bloat, lag that never drains, full-scan reconciliation timing out) only show up at
scale. Emulate the real **on-disk size**, not a row count:

```bash
# seed to a TARGET SIZE (batched, concurrent, server-side generation)
bun start rehearse seed-size --gib 200 --payload 6000 --batch 50000 --concurrency 4

# drive continuous write load with an append-only id ledger; leave running THROUGH the migration
bun start rehearse writer --ledger ledger/written_ids.log
```

**Chunked reconciliation (prod-grade).** A single `sum(hash)` over a multi-hundred-GB table is a
synchronized full scan on both sides and only says "differ / match". The default `chunked` mode
does one scan per side, buckets rows by a hash of their PK, compares N bucket checksums, and
**drills only the mismatched buckets** to name the exact divergent rows:

```bash
bun start reconcile                      # chunked, 256 buckets (default)
bun start reconcile --buckets 1024       # finer drill granularity for very large tables
bun start reconcile --mode full          # legacy single-aggregate (small tables only)
```

Output (and the per-bucket report at `ledger/reconcile-<ts>.json`) lists, per divergent row,
whether it is `missing_on_target`, `extra_on_target`, or `hash_diff`.

**Inject the gotchas yourself.** The point of a rehearsal is to break things on purpose and
verify the orchestrator notices:

```bash
bun start rehearse chaos drop-replica-identity   # then: preflight must FAIL
bun start rehearse chaos lose-row                # then: reconcile reports missing_on_target
bun start rehearse chaos corrupt-row             # then: reconcile reports hash_diff
bun start rehearse chaos stall-subscriber        # then: watch's WAL watchdog aborts
bun start rehearse chaos desync-sequence         # demonstrates the serial-PK collision (uuid is immune)
bun start rehearse chaos tsearch-drift           # reconcile STILL passes (generated col excluded)
```

| Scenario | Failure mode emulated | Gate that must catch it |
|---|---|---|
| `drop-replica-identity` | UPDATE/DELETE can't replicate | `preflight` ✗ |
| `lose-row` | dropped row on target | `reconcile` → missing_on_target |
| `corrupt-row` | silent content drift | `reconcile` → hash_diff |
| `stall-subscriber` | slot bloats source WAL | `watch` watchdog abort |
| `desync-sequence` | post-cutover PK collision | manual setval reminder (N/A uuid) |
| `tsearch-drift` | generated-col config skew | `reconcile` PASSES (guard works) |

Reconciliation is authoritative **after cutover** (writes stopped, lag drained): if the chunked
checksum matches exactly, nothing was lost — inflight or otherwise. The writer ledger is a
rehearsal-only extra proof that specifically isolates inflight loss during the initial copy.

### Scale + safety-gate harness (Docker)

`test/scale.harness.ts` builds the deliberately *annoying* 4-table schema (STORED `tsvector`
gen-column, IDENTITY + composite + no-PK tables, inter-table FKs, GUC-sensitive types,
unicode/NULLs), seeds it to volume, and runs the real pipeline with per-phase timing. Three
modes, selected by env flag — each exits non-zero if its expected gate does **not** fire, so
they double as CI assertions:

```bash
bun run test:scale         # default: static insert-only bulk copy + reconcile + cutover (ROWS=1M)

# WRITE_LOAD: concurrent INSERT/UPDATE/DELETE on documents + no-PK UPDATE/DELETE churn on the
# REPLICA IDENTITY FULL audit table run THROUGH the copy + streaming apply; writes stop before
# cutover; reconcile runs after cutover at lag=0 with a ledger inflight-loss check.
docker compose -f docker-compose.test.yml run --rm \
  -e ROWS=200000 -e WRITE_LOAD=1 runner \
  sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts'

# WATCHDOG_FIRE (negative): freeze apply + bloat source WAL → `watch` MUST abort via the WAL watchdog
# WRITE_THROUGH_CUTOVER (negative): keep writing through cutover → `cutover` MUST fail (lag never drains)
```

| Mode | What it stresses | Gate that must fire |
|---|---|---|
| (default) | initial COPY of the annoying schema at volume | reconcile PASSES |
| `WRITE_LOAD=1` | concurrent writes + no-PK FULL-identity apply through copy/stream | reconcile PASSES, ledger clean |
| `WATCHDOG_FIRE=1` | frozen apply bloating source WAL | `watch` → WAL watchdog abort |
| `WRITE_THROUGH_CUTOVER=1` | writes never stopped at cutover | `cutover` → "lag did not drain" |

The two negative modes are the at-scale complement to the `rehearse chaos` table above: same
gates (`watch` watchdog, `cutover` lag-drain guard), proven to abort under real load.

## Possible future backend: pgcopydb

`pgcopydb clone --follow` does parallel initial copy + snapshot-consistent catch-up and is
faster than a single subscription on large data — but it uses the replication protocol as its
own apply client rather than the Supabase-documented `CREATE SUBSCRIPTION` path. Spike it
against a throwaway project before betting a real migration on it.

## Layout

```
src/
  cli.ts              commander entry — one subcommand per step
  config.ts           zod schema (YAML) + env secrets schema
  db.ts               source/target postgres clients; subscription conn string; withRetry
  mgmt.ts             Supabase Management API client
  steps/
    doctor.ts         automated readiness checklist (pre-migration)
    run.ts            autonomous pipeline runner (CI/Lambda entry point)
    preflight.ts      read-only gate checks
    checks.ts         shared preflight/doctor SQL (subscribe grant, replication capacity)
    replicate.ts      publication + slot + subscription
    watch.ts          sync-state poll + WAL bloat watchdog
    reconcile.ts      counts + content-hash + ledger proof
    cutover.ts        lag drain + sequence resync + drop subscription
    teardown.ts       safe ordered cleanup
    status.ts         one-shot replication snapshot (for scheduled watchers)
    config-sync.ts    Management API config copy (secrets stripped)
    cli-wrappers.ts   supabase functions/storage wrappers
  rehearsal/
    seed.ts           seed source data (far-future expiry)
    writer.ts         continuous write load + id ledger
test/                 *.test.ts (unit) + integration.test.ts + scale/live harnesses + annoying-schema.ts
docs/RUNBOOK.md       the step-by-step runbook; §9 cutover, §12 rollback
```
