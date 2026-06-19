# pgshift

Typed CLI orchestrator for **near-zero-downtime Postgres-to-Postgres migration** via native
logical replication. Built for the large-class case where a plain dump/restore window is
unacceptable.

The core engine — `replicate → watch → reconcile → cutover → teardown` — is **generic
Postgres** (publication + slot + subscription, catalog-driven monitoring, checksum
reconciliation, lag-drain + sequence resync). It works for any PG15+ → PG15+ pair:
Supabase↔Supabase (any region, or same region for a tier change / project split),
self-hosted↔Supabase, or self-hosted↔self-hosted.

It is also **Supabase-aware**: when both ends are Supabase projects, optional commands wrap
the official `supabase` CLI and Management API for the non-replicated pieces (schema dump,
storage, edge functions, project config) instead of reimplementing them. Those commands
no-op / are skippable for non-Supabase migrations — see “Using pgshift for non-Supabase
migrations” below.

It owns the one piece nothing else automates — the **data replication state machine +
reconciliation + WAL watchdog**.

## Why this exists

A cross-region migration is ~7 independent workstreams. Most are already covered:

| Workstream | Handled by | In this tool |
|---|---|---|
| Schema / DDL | `supabase db push` / `pg_dump --schema-only` | you run it (see runbook) |
| **Table data, low-downtime** | native logical replication | **`replicate` + `watch`** |
| Sequences | `pg_dump --data-only --table='*_seq'` | `cutover` reminds you (N/A for uuid PKs) |
| Storage objects | `supabase storage cp` | `storage` wrapper |
| Edge Functions | `supabase functions download/deploy` | `functions` wrapper |
| Project config (Auth/Realtime/…) | Management API | **`config-sync`** (TS port, secrets stripped) |
| Secrets (SMTP/OAuth/JWT/…) | nothing — manual by design | flagged, never copied |

## Gotchas encoded in the tool (so you don't re-learn them at 2am)

- **`FOR ALL TABLES` needs superuser** → we always create an empty publication and `ADD TABLE` explicitly.
- **`copy_data = true`** → the subscription does a consistent initial copy; no fragile `pg_dump --snapshot` dance (the SQL-created slot can't export a snapshot anyway).
- **Generated columns** (e.g. `documents.search_vector`) are recomputed on the subscriber and are **excluded from the reconciliation hash** — hashing them causes false mismatches. They are **not free during the initial copy**: a heavy STORED generated column (a large `tsvector` over big text) is recomputed per row on the subscriber, and that CPU cost — not network/disk — bottlenecks the copy. Measured in the large rehearsal: **~11 MiB/s with the `search_vector` column vs ~80 MiB/s raw seed (~7× slower)**. For very large such columns, consider defining them as plain (non-generated) on the target during sync and converting to generated *after* the copy, or just budget the extra hours. `watch` now shows a live copy `%`.
- **WAL bloat is the #1 outage** → `watch` aborts if the slot retains more than `watchdog.maxRetainedWalMb` on the source.
- **Slot invalidation is unrecoverable** → if the source recycles WAL the subscriber never read (`max_slot_wal_keep_size` exceeded), the slot's `wal_status` flips to `lost` and replication is **permanently dead**. `watch` throws immediately on `wal_status=lost` (rather than spinning) and warns as it leaves `reserved`/`extended`.
- **A stuck subscription fails silently** → a tablesync/apply worker that error-loops (constraint violation, type mismatch, row conflict) leaves the table stuck below `srsubstate='r'` forever. `watch` reads `pg_stat_subscription_stats` and warns when `apply_error_count`/`sync_error_count` are *rising*, and warns if the subscription has **no running worker** (`pid` null = disabled/crashed).
- **A transient network blip won't kill a multi-hour watch** → `watch` tolerates up to 5 *consecutive* transient poll errors (logging each and retrying next poll) before giving up; the server-side copy keeps running regardless. Deliberate aborts (slot lost, WAL watchdog, sync timeout) always propagate immediately.
- **Reconcile only after lag drains to zero** → reconciling while the source still has un-replicated in-flight rows produces spurious `missing_on_target` diffs. `reconcile` checks the slot's un-confirmed WAL and warns if lag > 0. Run it post-cutover.
- **Verify writes are actually stopped before cutover** → `cutover` samples the source WAL LSN twice and counts active write-shaped client backends; if WAL is still advancing it warns loudly that draining to lag=0 may never finish and post-cutover writes will be lost. (Autovacuum can move WAL too, so it's a strong signal, not a hard stop — stop your app's writes first.)
- **Stable reconcile hash across regions** → row hashes render `row::text`, which depends on `TimeZone`/`DateStyle`/`IntervalStyle`/`extra_float_digits`/`bytea_output`. Source and target are different projects, so every connection in both pools pins these GUCs identically (and sets `statement_timeout=0` so a multi-minute full-table scan isn't killed).
- **Replica identity** → `preflight` fails any published table lacking a PK / unique index / `REPLICA IDENTITY FULL`.
- **Subscriber privilege** → `preflight` checks the target role can `CREATE SUBSCRIPTION` (documented-supported, but verified).
- **Cross-schema FKs (the `auth.users` trap)** → `public.documents.user_id` references `auth.users`. `auth` is not replicated, so its data must be restored on the target *before* the initial copy or every row is FK-rejected. `doctor` flags it; see "What this tool does NOT replicate".
- **Direct connection, not pooler**; target needs IPv6 (or the source's IPv4 add-on).
- **Teardown order** → disable → `SET (slot_name = NONE)` → drop subscription → drop slot → drop publication, or it hangs.
- **Never re-enable writes on the source** after cutover (split-brain) — `cutover` says so.
- **Rollback has a point of no return** → lossless rollback is free before you repoint the app (step 9e); after that, rolling back to the source loses every write the target took. The runbook has the full per-phase decision tree and an optional reverse-replication escape hatch. See `docs/RUNBOOK.md` §12.
- **Define abort thresholds before cutover** → the tool owns the data-plane gates (WAL watchdog, lag-drain deadline, `reconcile` verdict, apply-error count); your dashboards own the app-tier gates (5xx, p95, connection saturation). `docs/RUNBOOK.md` §9 maps both to migration-day signals.
- **New project = new JWT secret + API keys** → existing user sessions/JWTs invalidate (your users re-login), and the app's `SUPABASE_URL` + anon/service keys change. `config-sync` copies settings but **never secrets** — re-enter them by hand.
- **`config-sync` is a TS port, not yet validated against the live Management API** — always run `--dry-run` and eyeball the diff before applying.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.3 | runs the CLI directly from TypeScript — **no build step**, `pgshift` = `bun run src/cli.ts` |
| `supabase` CLI | ≥ 2.x | `config-sync`, `functions`, `storage`, and the auth/roles/schema dump-restore pre-step |
| `psql` + `pg_dump` | ≥ 15 (17 matches the source) | restoring roles/schema/auth onto the target; loading migrations |
| Docker + `docker compose` | v2 | **only** for the rehearsal harness and `test:integration` — not for a real migration |

Node.js is **not** required. The replication host must be able to reach the **direct**
Postgres hosts (IPv6, or the IPv4 add-on) — see the connection note below.

> **This tool needs an ACTIVE source.** Logical replication streams live WAL, so the source
> must be running with `wal_level=logical`. If your source project is **paused** — and
> especially if it has been paused **> 90 days** (no longer restorable via Studio) — it cannot
> stream WAL and this tool does not apply. Use Supabase's offline path instead: download the
> database backup + Storage objects from Project Overview and restore them into a new project
> ([Restore project after 90-day pause](https://supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause)).
> That path reuses the same building blocks this tool wraps: `supabase storage cp` for
> objects (identical syntax to our `storage` command) and the `sync_supabase_config.sh`
> Management-API config copy (which our `config-sync` is a TS port of), so `config-sync`,
> `functions`, and `storage` here remain useful even on the backup-restore route.

Runtime dependencies (installed by `bun install`): `commander` (CLI), `postgres` (the pg
client), `yaml` (config), `zod` (config validation). Dev: `@biomejs/biome`, `typescript`,
`@types/bun`.

## Getting started

```bash
git clone <repo> && cd pgshift
bun install                                           # commander, postgres, yaml, zod
cp migrate.config.example.yaml migrate.config.yaml    # set source/target refs + tables
cp .env.example .env                                  # DIRECT connection strings + PAT

bun start doctor --source-only                        # verify readiness (no target needed yet)
```

Secrets live only in `.env` (connection strings, access token). The YAML is non-secret and
commit-safe. Then follow the step-by-step **[`docs/RUNBOOK.md`](docs/RUNBOOK.md)**.

Development:

```bash
bun test                  # unit suite (fast, no DB)
bun run test:integration  # live replication/reconcile vs a throwaway Postgres pair (needs Docker)
bun run typecheck         # tsc --noEmit
bun run check             # biome format + lint
```

### Connection: direct vs pooler (IPv6 trap)

This tool needs a **direct** connection (`db.<ref>.supabase.co:5432`) on both ends —
the pooler (`*.pooler.supabase.com`) **cannot stream logical replication**. The direct
host is **IPv6-only** unless the project has the [IPv4 add-on](https://supabase.com/docs/guides/platform/ipv4-address).
If the box you run `pgshift` from has no IPv6 route, run it from one that does (a VM in
the target region is ideal) or enable the IPv4 add-on for the migration window. `doctor`
classifies each URL and tells you which situation you're in.

## What this tool does NOT replicate — do this FIRST

Logical replication moves **row data for the tables you list**, and nothing else. It does
not carry DDL, roles, sequences-as-DDL, or the Supabase-managed `auth` / `storage` schemas.
For a Supabase→Supabase move you must restore those onto the target **before** `replicate`,
or the initial copy fails — `public.documents.user_id` has an FK into `auth.users`, so copying
`documents` into a target with an empty `auth.users` is rejected row-by-row. `doctor` flags any
such cross-schema FK.

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

Also enable any **non-default extensions** on the target first (example-app uses `pg_cron`,
`pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `hypopg`, `index_advisor`, `supabase_vault`) —
`doctor` diffs source vs target extensions and lists the missing ones.

## Using pgshift for non-Supabase migrations

The replication engine is plain Postgres — the live integration suite runs it against vanilla
`postgres:16` containers with zero Supabase involvement. To migrate any PG15+ → PG15+ pair
(self-hosted↔self-hosted, self-hosted↔Supabase, same-region tier change, project split):

- **Required, same as always:** source has `wal_level=logical`; the target role can
  `CREATE SUBSCRIPTION`; the schema (DDL) is loaded on the target first (logical replication
  never carries DDL); the connection strings are **direct** (not a transaction pooler).
- **Use these commands:** `doctor`, `preflight`, `replicate`, `watch`, `reconcile`, `cutover`,
  `teardown`, `status`, `run`. All are engine-only and Supabase-agnostic.
- **Skip these Supabase-only commands:** `config-sync` (needs `SUPABASE_ACCESS_TOKEN`; no-ops
  without it), `functions` (set `functions.enabled: false`), `storage` (leave
  `storage.buckets: []`). For roles/auth/extension pre-steps, use ordinary `pg_dump`/`pg_dumpall`
  instead of the `supabase db dump` snippets above.
- **doctor stays useful:** its Supabase-host heuristics (pooler-vs-direct, IPv6, the `auth.users`
  trap) degrade to no-ops on a plain host — a non-Supabase host is simply “neither pooler nor
  direct” and the wal_level / replica-identity / version / `CREATE SUBSCRIPTION` /
  schema-loaded / extension-diff checks all still run.

The config defaults (`replication.slot`/`publication`/`subscription`) are generic names; set
them to whatever your environment prefers in `migrate.config.yaml`.

## Runbook

**Full idiot-proof, verified, step-by-step procedure for example-app:
[`docs/RUNBOOK.md`](docs/RUNBOOK.md)** — including the connectivity decision, the auth/roles/
extensions dump-restore pre-step, the billable target-creation step, and abort/rollback. The
block below is the quick reference.

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
#       must exist before the copy or the documents FK rejects every row)
#    c) load app schema. Skip the pg_cron schedule migration so the target
#       doesn't run cleanup independently while both DBs are live:
for f in $(ls path/to/supabase/migrations/*.sql | grep -v scheduled_jobs); do
  psql "$TARGET_DB_URL" -f "$f"
done

# 2. stand up replication (publication + slot + subscription; starts initial copy)
bun start replicate

# 3. watch the initial sync + WAL watchdog until all tables are 'ready'
bun start watch

# 4. (rehearsal) prove no loss under live write load — see Rehearsal below

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

The orchestration lives in the tool, not in a wrapper script. `run` executes the
pipeline end-to-end with machine-readable output and a meaningful exit code;
`status` is a one-shot health snapshot for a scheduled watcher.

```bash
# one command, non-interactive; exit 0 iff preflight+replicate+watch+reconcile all pass
bun start run --through reconcile --json

# cutover is destructive and REFUSED unless you assert source writes are stopped:
bun start run --through cutover --confirm-writes-stopped

# poll-once snapshot for a watcher; --require-synced exits non-zero until ready:
bun start status --json
bun start status --require-synced    # use in a wait loop
```

With `--json`, `run` emits NDJSON on stdout (`phase_start` / `phase_end` /
`summary`) while human logs go to stderr, so stdout stays parseable. Example
GitHub Action (the runner must reach the **direct** hosts — IPv6 or the IPv4
add-on, see the connection note above):

```yaml
name: migrate
on: { workflow_dispatch: {} }
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun start run --through reconcile --json
        env:
          SOURCE_DB_URL: ${{ secrets.SOURCE_DB_URL }}
          TARGET_DB_URL: ${{ secrets.TARGET_DB_URL }}
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```

## Rehearsal (test the whole thing on a throwaway project pair first)

Theory passing at 1M rows proves nothing — the failures that matter (slow initial copy holding
the slot, WAL bloat, lag that never drains, full-scan reconciliation timing out) only show up
at scale. So emulate the real **on-disk size**, not a row count:

```bash
# seed to a TARGET SIZE (batched, concurrent, server-side generation)
bun start rehearse seed-size --gib 200 --payload 6000 --batch 50000 --concurrency 4

# drive continuous write load with an append-only id ledger; leave running THROUGH the migration
bun start rehearse writer --ledger ledger/written_ids.log
```

### Chunked reconciliation (prod-grade)

A single `sum(hash)` over a large table is a synchronized full scan on both sides and only
says "differ / match". The default `chunked` mode does one scan per side, buckets rows by a
hash of their PK, compares N bucket checksums, and **drills only the mismatched buckets** to
name the exact divergent rows:

```bash
bun start reconcile                      # chunked, 256 buckets (default)
bun start reconcile --buckets 1024       # finer drill granularity for very large tables
bun start reconcile --mode full          # legacy single-aggregate (small tables only)
```

Output (and the per-bucket report at `ledger/reconcile-<ts>.json`) lists, per divergent row,
whether it is `missing_on_target`, `extra_on_target`, or `hash_diff`.

### Inject the gotchas yourself — confirm the gates catch them

The point of a rehearsal is to break things on purpose and verify the orchestrator notices:

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

## Tests

Two tiers:

```bash
bun test                 # unit tier — pure logic, no DB, always runs
```

Unit tier (always on, runs in CI): zod config parsing + identifier/SQL-injection guards,
config-sync secret stripping, bucket-diff classification, conn-string builder.

```bash
# integration tier — opt-in, exercises the live replication + reconcile SQL
# against a throwaway Postgres pair. One command, no manual container wrangling:
bun run test:integration
```

This stands up two ephemeral `postgres:16` containers (source with `wal_level=logical`)
plus a bun runner, **all on one compose network**, runs `test/integration.test.ts` inside
it, and tears everything down. See `docker-compose.test.yml`.

> **Why a shared network and not two bare `docker run`s with `localhost`:** `replicate.ts`
> uses one connection string both for its own libpq connection and as the subscription's
> `CONNECTION`, which the *target's* walreceiver dials. With `localhost:5432` the target
> would resolve `localhost` to itself, not the source, so replication never connects. Inside
> a compose network the subscription uses the service-DNS name `source:5432`, which resolves
> identically from the runner and the target.

To point the tier at your own pair instead, set `TEST_SOURCE_DB_URL` + `TEST_TARGET_DB_URL`
(both must be reachable under the *same* name from wherever the target runs) and
`bun test test/integration.test.ts`. Without those vars the tier skips, so CI stays green on
unit tests alone.

The tier stands up real logical replication and asserts each fault is caught: happy-path
reconcile clean, `lose-row` → reconcile fails, `corrupt-row` → reconcile fails, generated
column excluded (clean data still reconciles), and `drop-replica-identity` → `preflight` rejects.

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
  db.ts               source/target postgres clients; subscription conn string
  mgmt.ts             Supabase Management API client
  steps/
    preflight.ts      read-only gate checks
    replicate.ts      publication + slot + subscription
    watch.ts          sync-state poll + WAL bloat watchdog
    reconcile.ts      counts + content-hash + ledger proof
    cutover.ts        lag drain + drop subscription
    teardown.ts       safe ordered cleanup
    config-sync.ts    Management API config copy (secrets stripped)
    cli-wrappers.ts   supabase functions/storage wrappers
  rehearsal/
    seed.ts           seed source data (far-future expiry)
    writer.ts         continuous write load + id ledger
```
