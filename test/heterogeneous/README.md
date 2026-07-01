# Heterogeneous integration harness

End-to-end verification for the `DebeziumEngine` (MySQL **and SQL Server** → Postgres, no Kafka —
[`docs/HETEROGENEOUS.md`](../../docs/HETEROGENEOUS.md) §5–6). The production analogue of the
proven spike (`spike/debezium-mysql/`), but it drives **pgshift's real engine** rather than a
hand-written compose service. There are two harnesses, one per source engine:

| Source | Harness | Compose |
|---|---|---|
| MySQL (binlog) | `harness.ts` | `docker-compose.yml` |
| SQL Server (CDC) | `harness-sqlserver.ts` | `docker-compose.sqlserver.yml` |

> **Requires Docker. Not part of `bun test`** (no `.test.ts` suffix), and not runnable on the dev
> box per the no-running-daemons safety rule. Run it in a Docker-capable environment (CI / your
> own machine). The engine's `replicate`/`teardown` orchestration logic is separately unit-tested
> with a mock IO seam in [`test/debezium-runtime-io.test.ts`](../debezium-runtime-io.test.ts);
> this harness validates the *real* Docker + Debezium behaviour those mocks stand in for.

## Run

```bash
bun run test/heterogeneous/harness.ts             # MySQL source
bun run test/heterogeneous/harness-sqlserver.ts   # SQL Server source
```

### MySQL harness

The harness self-contains the whole sequence (exit 0 = PASS):

1. **build** the engine image `pgshift/debezium-server:3.6.0.CR1` from `images/debezium-server/`;
2. **up** MySQL (`example-mysql`, 4 seeded `inventory.customers`) + an EMPTY Postgres target on
   the `pgshift-dbz-it` network, published to host ports `53306` / `55432`;
3. **schema-translate** — `draftTargetSchema()` reads the MySQL `information_schema`, drafts the
   Postgres DDL (logging any guided decisions), and applies it to the target (production writes it
   for human sign-off; the harness auto-applies);
4. **replicate** — `engine.replicate()` stages the rendered `application.properties`, `docker
   run`s the Debezium container onto `pgshift-dbz-it`, and waits for `/q/health`;
5. **snapshot assert** — the 4 seeded rows land in `public.customers`;
6. **CDC assert** — a row INSERTed in MySQL streams through the binlog and appears in Postgres;
7. **reconcile** — `engine.reconcile()` (count + portable aggregates via `mysql2`) reports PASS;
8. **watch** — `engine.watch()` confirms connector health + caught-up, resolves;
9. **cutover** — `engine.cutover()` runs the binlog write-stop gate + drain + sequence resync and
   stops the container;
10. **teardown** — `engine.teardown()` removes the container + offset volume; compose `down -v`.

reconcile/watch/cutover run in the host process and query MySQL directly, so the harness points
`SOURCE_DB_URL` at the published `127.0.0.1:53306` for them (replicate's rendered config keeps the
in-network `mysql:3306`).

### SQL Server harness

Same shape, with SQL-Server-specific seeding (the `mcr.microsoft.com/mssql/server:2022-latest`
image is not pre-seeded). On the `pgshift-dbz-it-mssql` network, host ports `51433` / `55433`,
health on `18081`:

1. **build** the engine image (same `images/debezium-server/` — the Debezium Server image carries
   the SQL Server connector);
2. **up** SQL Server (Developer edition, `MSSQL_AGENT_ENABLED=true` so the CDC capture job runs) +
   an EMPTY Postgres target;
3. **seed** — `CREATE DATABASE inventory`, `sys.sp_cdc_enable_db`, `dbo.customers` (IDENTITY PK),
   `sys.sp_cdc_enable_table`, 4 rows — via `sqlcmd` inside the container;
4. **translate** — `draftTargetSchemaSqlServer()` reads the T-SQL catalog, drafts the DDL
   (IDENTITY → flagged decision), applies it, signs off;
5. **replicate** → **snapshot** (4 rows) → **CDC** (insert streams via the cdc change-tables) →
   **reconcile** (bracket-quoted, `LEN`, sqlserver dialect) → **watch** → **cutover** (the
   CDC-`max_lsn` write-stop gate instead of the binlog position) → **teardown**.

> SQL Server CDC needs **SQL Server Agent running** (the capture/cleanup jobs) — hence
> `MSSQL_AGENT_ENABLED=true`. The capture job polls roughly every 5s, so the snapshot/CDC waits
> allow extra tries vs the MySQL harness.

## Topology

```
                 docker network: pgshift-dbz-it
  ┌───────────┐        ┌──────────────────────────┐        ┌────────────┐
  │  mysql    │binlog─▶ │ pgshift-dbz-dbz           │ JDBC ─▶ │ postgres   │
  │ inventory │        │ (engine.replicate spawned) │        │  target    │
  └───────────┘        │  Debezium Server 3.6.0.CR1│        └────────────┘
                       └──────────────────────────┘
       ▲ 53306                  ▲ 18080 (/q/health)            ▲ 55432
       └──── harness exec inserts          health probe        harness row asserts ┘
```

The rendered Debezium config addresses `mysql` / `postgres` by their in-network names; the
harness addresses them by published host ports for its own inserts + assertions.

## Wiring knobs (env the engine reads)

| Env | Harness value | Meaning |
|---|---|---|
| `PGSHIFT_DBZ_NETWORK` | `pgshift-dbz-it` | network the Debezium container joins |
| `PGSHIFT_DBZ_METRICS_PORT` | `18080` | host port the container's 8080 is published on (health) |
| `PGSHIFT_DBZ_IMAGE` | (default) | engine image tag (default the pinned `DEBEZIUM_IMAGE`) |
| `PGSHIFT_DBZ_STAGE_DIR` | (default tmp) | where the rendered `application.properties` is staged |

## Status

The full lifecycle (replicate / reconcile / watch / cutover / teardown) is exercised and passes
against real Debezium 3.6.0.CR1 + MySQL 8.2 + Postgres 16. The SQL Server harness
(`harness-sqlserver.ts`) mirrors it against SQL Server 2022 (Developer, CDC) + Postgres 16. See
[`docs/HETEROGENEOUS.md`](../../docs/HETEROGENEOUS.md) §5–6.
