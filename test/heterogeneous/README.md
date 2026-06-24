# Heterogeneous integration harness

End-to-end verification for the `DebeziumEngine` (MySQL → Postgres, no Kafka —
[`docs/HETEROGENEOUS.md`](../../docs/HETEROGENEOUS.md) §5). The production analogue of the
proven spike (`spike/debezium-mysql/`), but it drives **pgshift's real engine** rather than a
hand-written compose service.

> **Requires Docker. Not part of `bun test`** (no `.test.ts` suffix), and not runnable on the dev
> box per the no-running-daemons safety rule. Run it in a Docker-capable environment (CI / your
> own machine). The engine's `replicate`/`teardown` orchestration logic is separately unit-tested
> with a mock IO seam in [`test/debezium-runtime-io.test.ts`](../debezium-runtime-io.test.ts);
> this harness validates the *real* Docker + Debezium behaviour those mocks stand in for.

## Run

```bash
bun run test/heterogeneous/harness.ts
```

The harness self-contains the whole sequence (exit 0 = PASS):

1. **build** the engine image `pgshift/debezium-server:3.6.0.Beta2` from `images/debezium-server/`;
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

## Topology

```
                 docker network: pgshift-dbz-it
  ┌───────────┐        ┌──────────────────────────┐        ┌────────────┐
  │  mysql    │binlog─▶ │ pgshift-dbz-dbz           │ JDBC ─▶ │ postgres   │
  │ inventory │        │ (engine.replicate spawned) │        │  target    │
  └───────────┘        │  Debezium Server 3.6.0.Beta2│        └────────────┘
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
against real Debezium 3.6.0.Beta2 + MySQL 8.2 + Postgres 16. See
[`docs/HETEROGENEOUS.md`](../../docs/HETEROGENEOUS.md) §5.
