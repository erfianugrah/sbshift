# pgshift DebeziumEngine image

The production container image for the heterogeneous data plane (`DebeziumEngine`,
[`docs/HETEROGENEOUS.md`](../../docs/HETEROGENEOUS.md) §3): Debezium Server + the no-Kafka JDBC
sink + the Postgres driver. Promoted from the proven spike (`spike/debezium-mysql/`) to a
maintained asset.

## Build

```bash
docker build -t pgshift/debezium-server:3.6.0.Beta2 images/debezium-server/
```

The tag must match the pin in [`src/engine/debezium-runtime.ts`](../../src/engine/debezium-runtime.ts)
(`DEBEZIUM_IMAGE` / `DEBEZIUM_SERVER_VERSION`) — the engine's run-spec
([`src/engine/debezium-runspec.ts`](../../src/engine/debezium-runspec.ts)) launches exactly this
tag.

## What it adds over the stock image (spike finding #3)

| Layer | Why |
|---|---|
| `debezium-server-jdbc` + transitive deps | The stock image bundles 14 messaging sinks (kafka/kinesis/pubsub/redis/…) but **no** JDBC sink. |
| `org.postgresql:postgresql` driver | Debezium Server ships **no** target-DB driver ("add the driver to `lib/`"). |

A Maven stage resolves `jdbc-sink.pom.xml` and copies the jars into `/debezium/lib/`.

## Version pin

`debezium-server-jdbc` and the `FROM` server image are pinned **together** at `3.6.0.Beta2`. The
JDBC sink is a 3.6-only, not-yet-GA feature; the newer `3.6.0.CR1` *jar* exists but there is no
`3.6.0.CR1` server *image*, so CR1-jar-on-Beta2-core would be an unsupported skew. Re-pin both
when a matching image+jar pair ships (ideally `3.6.0.Final`) and flip `DEBEZIUM_RUNTIME_GA`. See
[`docs/HETEROGENEOUS.md`](../../docs/HETEROGENEOUS.md) §5 for the full delivery-vehicle decision.

## How the engine runs it

The engine stages the rendered `application.properties`
([`debezium-config.ts`](../../src/engine/debezium-config.ts)) and a persistent data volume, then
launches one detached container per the run-spec:

- the properties file is mounted **read-only** at `/debezium/config/application.properties`
  (Quarkus external config — mount the file, not the dir, spike finding #4);
- a persistent volume backs `/debezium/data` (offset + schema-history `*.dat`) so a restart does
  not re-snapshot the whole source;
- the Quarkus port `8080` is published for the health endpoint (`/q/health`) and the metrics the
  `watch` step scrapes.

The container needs no command args — Debezium Server auto-loads `./config/application.properties`.
