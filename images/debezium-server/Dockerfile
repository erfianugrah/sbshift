# pgshift DebeziumEngine image — Debezium Server + the no-Kafka JDBC sink + the Postgres driver.
#
# This is the production image the DebeziumEngine runs (the heterogeneous data plane,
# HETEROGENEOUS.md §3). Built from the spike-proven manifest (spike/debezium-mysql/), promoted
# to a maintained asset. Tag it to match the pin: `pgshift/debezium-server:3.6.0.Beta2`
# (src/engine/debezium-runtime.ts: DEBEZIUM_IMAGE / DEBEZIUM_SERVER_VERSION).
#
# Two things the stock server image lacks and this image adds (spike finding #3):
#  - the JDBC sink (`debezium-server-jdbc`) — the base image bundles 14 messaging sinks
#    (kafka/kinesis/pubsub/redis/…) but NOT the JDBC sink; resolved via Maven below.
#  - the target DB driver — Debezium Server ships none ("add the driver to lib/"); the pom pulls it.
#
# Version alignment (HETEROGENEOUS.md §5 decision): the sink jar version MUST match the server
# core in the FROM image. The 3.6 server image tops out at 3.6.0.Beta2, so both are pinned there —
# a newer CR1 jar on a Beta2 core would be an unsupported skew. Re-pin both together when a
# matching image+jar pair ships (ideally 3.6.0.Final).

FROM maven:3.9-eclipse-temurin-21 AS deps
WORKDIR /build
COPY jdbc-sink.pom.xml pom.xml
RUN mvn -q -B dependency:copy-dependencies -DoutputDirectory=/jars -DincludeScope=runtime

FROM quay.io/debezium/server:3.6.0.Beta2
USER root
# Only the jars the stock image lacks land here; same-named same-version jars overwrite harmlessly.
COPY --from=deps /jars/ /debezium/lib/
USER debezium
