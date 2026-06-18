import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema, type Secrets, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { runChaos } from "../src/rehearsal/chaos.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { teardown } from "../src/steps/teardown.ts";
import { watch } from "../src/steps/watch.ts";

/**
 * LIVE integration tier. Opt-in: skipped unless TEST_SOURCE_DB_URL and
 * TEST_TARGET_DB_URL point at two THROWAWAY Postgres 15+ databases where the
 * source has wal_level=logical and the role can CREATE SUBSCRIPTION.
 *
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:16 -c wal_level=logical
 *   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=pw postgres:16
 *   TEST_SOURCE_DB_URL=postgresql://postgres:pw@localhost:5432/postgres \
 *   TEST_TARGET_DB_URL=postgresql://postgres:pw@localhost:5433/postgres bun test
 *
 * This is the only tier that proves the replication + reconcile SQL actually
 * works against a real engine, and that each fault is caught.
 */

const HAVE_DBS = Boolean(process.env.TEST_SOURCE_DB_URL && process.env.TEST_TARGET_DB_URL);
const d = HAVE_DBS ? describe : describe.skip;
const TABLE = "public.itest";

function buildConfig(): Config {
  return ConfigSchema.parse({
    source: { ref: "a".repeat(20) },
    target: { ref: "b".repeat(20) },
    replication: {
      tables: [TABLE],
      publication: "itest_pub",
      slot: "itest_slot",
      subscription: "itest_sub",
    },
    reconcile: { tables: [{ name: TABLE }] },
    watchdog: { maxRetainedWalMb: 1_000_000, pollIntervalSec: 1, syncTimeoutMin: 2 },
  });
}

function buildSecrets(): Secrets {
  return SecretsSchema.parse({
    SOURCE_DB_URL: process.env.TEST_SOURCE_DB_URL,
    TARGET_DB_URL: process.env.TEST_TARGET_DB_URL,
  });
}

async function createSchema(db: Db): Promise<void> {
  await db.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  // includes a STORED generated column to exercise the reconcile exclusion path
  await db.unsafe(`CREATE TABLE ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content text,
    n int,
    g tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED
  )`);
}

const cfg = buildConfig();
const secrets = HAVE_DBS ? buildSecrets() : (null as unknown as Secrets);
let source: Db;
let target: Db;
let close: () => Promise<void>;

/** Full reset: tear down replication, recreate schema both sides, seed, replicate, sync. */
async function resetAndSync(rows: number): Promise<void> {
  await teardown(source, target, cfg);
  await createSchema(source);
  await createSchema(target);
  await source.unsafe(
    `INSERT INTO ${TABLE} (content, n) SELECT 'row ' || g, g FROM generate_series(1, $1) g`,
    [rows],
  );
  await replicate(source, target, cfg, secrets);
  await watch(source, target, cfg);
}

d("live replication + reconciliation", () => {
  beforeAll(async () => {
    const c = connect(secrets);
    source = c.source;
    target = c.target;
    close = c.close;
    const [w] = await source`SHOW wal_level`;
    if (w?.wal_level !== "logical")
      throw new Error("TEST_SOURCE_DB_URL must have wal_level=logical");
  });

  afterAll(async () => {
    if (!HAVE_DBS) return;
    await teardown(source, target, cfg);
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(() => {});
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(() => {});
    await close();
  });

  test("happy path: identical source/target reconcile clean", async () => {
    await resetAndSync(200);
    expect(await reconcile(source, target, cfg)).toBe(true);
  }, 60_000);

  test("lose-row: a row dropped on target is caught", async () => {
    await resetAndSync(200);
    await runChaos({ source, target, arg: TABLE }, "lose-row");
    expect(await reconcile(source, target, cfg)).toBe(false);
  }, 60_000);

  test("corrupt-row: silent content drift on target is caught", async () => {
    await resetAndSync(200);
    await runChaos({ source, target, arg: TABLE }, "corrupt-row");
    expect(await reconcile(source, target, cfg)).toBe(false);
  }, 60_000);

  test("generated column is excluded — tsvector differences do not cause false mismatch", async () => {
    await resetAndSync(200);
    // The generated column (tsvector) is recomputed on the subscriber and is
    // excluded from the hash; a clean dataset must still reconcile true.
    expect(await reconcile(source, target, cfg)).toBe(true);
  }, 60_000);

  test("drop-replica-identity: preflight rejects a table with REPLICA IDENTITY NOTHING", async () => {
    await createSchema(source);
    await createSchema(target);
    await runChaos({ source, target, arg: TABLE }, "drop-replica-identity");
    expect(preflight(source, target, cfg)).rejects.toThrow();
  }, 60_000);
});
