import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema, type Secrets, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { runChaos } from "../src/rehearsal/chaos.ts";
import { cutover } from "../src/steps/cutover.ts";
import { doctor } from "../src/steps/doctor.ts";
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
const TABLE2 = "public.itest2";

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
  // seq_id (bigserial) gives the table an OWNED sequence so the cutover
  // sequence-resync path has something to discover + setval.
  await db.unsafe(`CREATE TABLE ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq_id bigserial,
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
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`).catch(() => {});
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`).catch(() => {});
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
    await expect(preflight(source, target, cfg)).rejects.toThrow(); // L-14: was missing await
  }, 60_000);

  test("doctor: clean synced pair reports zero failures", async () => {
    await resetAndSync(50);
    const r = await doctor(cfg, secrets);
    expect(r.fail).toBe(0);
  }, 60_000);

  test("doctor: missing target schema is a failure", async () => {
    await teardown(source, target, cfg);
    await createSchema(source);
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    const r = await doctor(cfg, secrets);
    expect(r.fail).toBeGreaterThan(0);
  }, 60_000);

  test("cutover: owned sequence is resynced to the source value on the target", async () => {
    await resetAndSync(200);
    // The source seq advanced to 200 on insert; replicated rows carry literal
    // values so the TARGET sequence never advanced. Confirm the gap exists...
    const seqName = `${TABLE}_seq_id_seq`;
    const [tBefore] = await target.unsafe(`SELECT last_value, is_called FROM ${seqName}`);
    expect(tBefore?.is_called === false || Number(tBefore?.last_value) < 200).toBe(true);
    // ...then cutover (writes are stopped, lag drains) must setval it forward.
    await cutover(source, target, cfg, { maxLagWaitSec: 30 });
    const [s] = await source.unsafe(`SELECT last_value FROM ${seqName}`);
    const [t] = await target.unsafe(`SELECT last_value, is_called FROM ${seqName}`);
    expect(Number(t?.last_value)).toBe(Number(s?.last_value));
    expect(t?.is_called).toBe(true);
  }, 60_000);

  test("replicate: REFRESH PUBLICATION picks up a table added after the subscription", async () => {
    await resetAndSync(50);
    // A second table, created + published AFTER the subscription exists.
    await source.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`);
    await target.unsafe(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`);
    await source.unsafe(`CREATE TABLE ${TABLE2} (id int PRIMARY KEY, v text)`);
    await target.unsafe(`CREATE TABLE ${TABLE2} (id int PRIMARY KEY, v text)`);
    await source.unsafe(`INSERT INTO ${TABLE2} SELECT g, 'v' || g FROM generate_series(1, 10) g`);
    await source.unsafe(`ALTER PUBLICATION ${cfg.replication.publication} ADD TABLE ${TABLE2}`);
    // Re-running replicate sees the existing subscription and issues REFRESH
    // PUBLICATION, which starts an initial copy for the newly published table.
    await replicate(source, target, cfg, secrets);
    // Poll until the new table's rows land on the target (tablesync is async).
    let copied = 0;
    for (let i = 0; i < 30 && copied < 10; i++) {
      const [r] = await target.unsafe(`SELECT count(*)::int AS n FROM ${TABLE2}`);
      copied = Number(r?.n ?? 0);
      if (copied < 10) await new Promise((res) => setTimeout(res, 500));
    }
    expect(copied).toBe(10);
  }, 60_000);
});
