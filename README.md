# supabase-region-migrate

Typed CLI orchestrator for **cross-region Supabase → Supabase migration** with minimal
downtime, via native Postgres logical replication. Built for the large-class case where a
plain dump/restore window is unacceptable.

It owns the one piece nothing else automates — the **data replication state machine +
reconciliation + WAL watchdog** — and wraps the official `supabase` CLI and Management API
for the rest (schema, storage, functions, project config) instead of reimplementing them.

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
- **Generated columns** (e.g. `documents.search_vector`) are recomputed on the subscriber and are **excluded from the reconciliation hash** — hashing them causes false mismatches.
- **WAL bloat is the #1 outage** → `watch` aborts if the slot retains more than `watchdog.maxRetainedWalMb` on the source.
- **Replica identity** → `preflight` fails any published table lacking a PK / unique index / `REPLICA IDENTITY FULL`.
- **Subscriber privilege** → `preflight` checks the target role can `CREATE SUBSCRIPTION` (documented-supported, but verified).
- **Direct connection, not pooler**; target needs IPv6 (or the source's IPv4 add-on).
- **Teardown order** → disable → `SET (slot_name = NONE)` → drop subscription → drop slot → drop publication, or it hangs.
- **Never re-enable writes on the source** after cutover (split-brain) — `cutover` says so.

## Setup

```bash
bun install
cp migrate.config.example.yaml migrate.config.yaml   # edit refs + tables
cp .env.example .env                                  # DIRECT connection strings + PAT
```

Secrets live only in `.env` (connection strings, access token). The YAML is non-secret and commit-safe.

## Runbook

```bash
# 0. read-only sanity — versions, wal_level, subscribe grant, replica identity
bun start preflight

# 1. load schema on the TARGET first (logical replication does NOT carry DDL).
#    Skip the pg_cron schedule migration so the target doesn't delete independently:
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

## Rehearsal (test the whole thing on a throwaway project pair first)

```bash
# seed the source, then drive continuous write load with an append-only id ledger
bun start rehearse seed --rows 1000000 --payload 6000
bun start rehearse writer --ledger ledger/written_ids.log   # leave running THROUGH the migration

# after cutover + lag drain, reconcile: counts + content-hash + ledger left-join
bun start reconcile
```

`reconcile` passes only if row counts match, content hashes match, and every id the writer
logged exists on the target — i.e. zero inflight loss including writes during the initial copy.

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
