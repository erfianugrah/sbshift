# Changelog

All notable changes to sbshift are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, minor
versions may carry behaviour changes.

## [0.3.0] - 2026-07-03

### Changed

- **Project renamed `pgshift` -> `sbshift`** across the binary, `package.json`
  name/bin, docs, and the skill. The GitHub repo moved to
  `github.com/erfianugrah/sbshift` (the old URL redirects). Runtime state/log
  filenames follow suit (`.sbshift-sandbox.json`, `logs/sbshift-<cmd>-<ts>.log`).
  No CLI-flag or config-schema changes beyond the command name itself.
- Replication is now **direct-only, enforced in code** (was: doctor advisory).
  `replicate` hard-errors before `CREATE SUBSCRIPTION` if the effective
  replication CONNECTION (`SOURCE_REPLICATION_URL`, else `SOURCE_DB_URL`)
  resolves to a Supavisor pooler host - the pooler cannot stream logical
  replication WAL, so a subscription pointed at one silently never syncs. New
  pure guard `assertDirectReplicationConn()` in `src/db.ts` (unit-tested).
- `doctor` now **FAILs** (was: warned) when `SOURCE_DB_URL` is a pooler and
  `SOURCE_REPLICATION_URL` is unset - that config would send `CREATE
  SUBSCRIPTION` to the pooler. The failure message points at both fixes: set
  `SOURCE_REPLICATION_URL` to the direct host, or enable the source's IPv4
  add-on and use the direct host as `SOURCE_DB_URL`.
- Docs (README + skill) reframed: the recommended answer for a non-IPv6 runner
  is the **IPv4 add-on** (or running from an IPv6-capable host). The
  pooler-split via `SOURCE_REPLICATION_URL` is documented as a last-resort
  fallback, with the clarification that it does NOT route WAL through the pooler
  (replication stays direct; the pooler only fronts sbshift's own
  admin/seed/reconcile queries).

## [0.2.0] - 2026-07-01

First tagged release. Two migration tracks, at two maturity levels.

### Postgres -> Postgres / Supabase (stable, production-usable)

- Near-zero-downtime migration over native logical replication: `doctor`,
  `bootstrap`, `preflight`, `replicate`, `watch`, `reconcile`, `cutover`,
  `verify`, `teardown`, plus Supabase wrappers (`config-sync`, `provision`,
  `claim`) and `sandbox` / `run` / `status`.
- `bootstrap` automates the non-replicated pre-step (extensions -> roles ->
  schema) via the system `pg_dumpall`/`pg_dump`/`psql`, Supabase-aware (filters
  the managed schemas/roles and the event-trigger restore trap).
- Safety gates proven to FIRE in CI, not just exist: WAL-bloat watchdog abort,
  cutover-refuses-under-writes lag-drain guard, concurrent-write reconcile with
  an inflight-loss ledger check.
- Byte-exact `row::text` checksum reconcile with a per-table `hashColumns` pin.
- Direct-vs-pooler (IPv6 trap) split via `SOURCE_REPLICATION_URL`, classified
  and validated by `doctor`.

### MySQL and SQL Server / Azure SQL -> Postgres (beta, runnable with eyes open)

- Heterogeneous data plane over Debezium Server's no-Kafka JDBC sink
  (`DebeziumEngine`), forking on `cfg.source.engine`. Full lifecycle
  harness-verified end-to-end in CI against real MySQL 8.2 and SQL Server 2022
  (Developer, CDC) + Debezium 3.6.0.CR1 + Postgres 16.
- `sbshift translate` drafts the source-DDL -> Postgres-DDL with a human
  sign-off gate; cutover is blocked until the drafted schema is ratified.
- Cross-engine `reconcile` (count + portable per-column aggregates) with the
  byte-exact-hash downgrade logged loudly.
- Engine-aware write-stop cutover gate: MySQL binlog position / SQL Server CDC
  `max_lsn`.
- `sbshift guide <engine>` + live `doctor` engine-prep playbooks (KB-driven,
  provenance-stamped, drift-checked).

### Added

- Retention watchdog in the Debezium `watch()`: warns at
  `watchdog.retentionWarnFraction` (default 0.8) of the source change-log window
  and hard-aborts at 1.0, reading `@@binlog_expire_logs_seconds` (MySQL) or the
  CDC cleanup retention from `msdb.dbo.cdc_jobs` (SQL Server). The CDC analogue
  of the native WAL watchdog; a probe failure degrades to a no-op.
- Azure SQL Database tier gate: `sqlserver.azure_tier`, a fail-severity
  source-prep check `doctor` runs live, blocks Basic/S0/S1/S2 (CDC needs vCore
  or DTU S3+) before connector start. Uses `DATABASEPROPERTYEX` so it compiles
  on every SQL Server edition and no-ops off Azure.
- Real-cloud rehearsal harness `test/heterogeneous/rehearse-cloud.ts`: drives the
  real engine (`translate --apply` -> `replicate` -> `watch` -> `reconcile` ->
  `teardown`) against a live cloud source (Azure SQL / RDS MySQL) + real Postgres
  target, loading config + secrets like the CLI. Never stops source writes, never
  cuts over. Azure SQL / RDS MySQL source-prep + connectivity notes in
  `docs/GUIDED-MIGRATION.md` §8b.

### Changed

- Debezium runtime re-pinned `3.6.0.Beta2` -> `3.6.0.CR1` now that a matched
  server-image + JDBC-sink jar pair ships at CR1. Still pre-GA
  (`DEBEZIUM_RUNTIME_GA=false`); `3.6.0.Final` remains unscheduled.

### Known limitations

- Heterogeneous reconcile is count + portable aggregates, not a byte-exact row
  hash (a length-preserving text edit is invisible to it).
- Debezium is pinned to a pre-release; the JDBC sink gives weaker delivery
  guarantees than Kafka Connect, so sbshift's reconcile + fail-closed cutover
  are load-bearing regardless of GA status.
- Schema translation never auto-applies; cutover is gated on human sign-off.

[0.3.0]: https://github.com/erfianugrah/sbshift/releases/tag/v0.3.0
[0.2.0]: https://github.com/erfianugrah/sbshift/releases/tag/v0.2.0
