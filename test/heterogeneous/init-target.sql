-- Pre-created target schema for the heterogeneous integration harness.
--
-- In production the DebeziumEngine runs the JDBC sink with schema.evolution=none and pgshift
-- pre-creates the target from the `guided` schema-translation draft (GUIDED-MIGRATION.md §7,
-- spike finding #6). This file is the harness stand-in for that translated DDL: the Postgres
-- shape of MySQL's seeded `inventory.customers`.
--
-- The Debezium RegexRouter strips the `dbz.inventory.` topic prefix, so rows land in the bare
-- `public.customers`; primary.key.mode=record_key upserts on the MySQL PK (id).
CREATE TABLE IF NOT EXISTS public.customers (
  id         integer PRIMARY KEY,
  first_name text,
  last_name  text,
  email      text
);
