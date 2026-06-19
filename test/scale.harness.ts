/**
 * Scale harness — NOT a unit test. Builds a deliberately ANNOYING multi-table
 * schema (the kind that breaks naive tools), seeds it to volume, and runs the
 * real pipeline (preflight → replicate → watch → reconcile → cutover) with
 * per-phase wall-clock timing. The point is to stress every gotcha at scale:
 *
 *   - a STORED generated column (tsvector) — the copy CPU bottleneck
 *   - an IDENTITY pk (owned sequence via deptype 'i') + a COMPOSITE pk
 *     + a NO-PK table (REPLICA IDENTITY FULL)
 *   - inter-table FKs (child copied before parent — relies on the subscriber's
 *     replica-role FK suppression during initial sync)
 *   - GUC-sensitive types in row::text: numeric, double precision, timestamptz,
 *     interval, inet, bytea, jsonb, text[], citext, an enum
 *   - unicode + NULLs
 *
 * Run inside the test compose network (service-DNS source:/target:):
 *   docker compose -f docker-compose.test.yml run --rm \
 *     -e ROWS=1000000 -e PAYLOAD_CHARS=300 runner \
 *     sh -c 'bun install --frozen-lockfile && bun run test/scale.harness.ts'
 *
 * ROWS sizes the documents (gen-column) table; users/events/audit scale off it.
 *
 * WRITE_LOAD=1 turns the static benchmark into a resilience stress test: a
 * concurrent INSERT/UPDATE/DELETE writer runs against the source THROUGH the
 * initial copy and streaming apply (so WAL retention, lag, and the now-armed
 * watchdog are actually exercised), writes are stopped before cutover, and
 * reconcile runs AFTER cutover at lag=0 with a ledger check proving zero
 * inflight loss. Tunables: WATCHDOG_MB (default 2048 under load), WRITE_INTERVAL_MS
 * (default 4), WRITE_AFTER_SEC (default 5 — extra streaming-apply load after copy).
 */

import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { log } from "../src/log.ts";
import { writer } from "../src/rehearsal/writer.ts";
import { cutover } from "../src/steps/cutover.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { teardown } from "../src/steps/teardown.ts";
import { watch } from "../src/steps/watch.ts";
import { createSchema, seedSource } from "./annoying-schema.ts";

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const WRITE_LOAD = process.env.WRITE_LOAD === "1";
const WATCHDOG_MB = Number(process.env.WATCHDOG_MB ?? (WRITE_LOAD ? 2048 : 50_000_000));
const WRITE_INTERVAL_MS = Number(process.env.WRITE_INTERVAL_MS ?? 4);
const WRITE_AFTER_SEC = Number(process.env.WRITE_AFTER_SEC ?? 5);
const LEDGER_PATH = `ledger/scale-writer-${Date.now()}.log`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TABLES = ["public.users", "public.documents", "public.events", "public.audit"];

const cfg = ConfigSchema.parse({
  source: { ref: "a".repeat(20) },
  target: { ref: "b".repeat(20) },
  replication: {
    tables: TABLES,
    publication: "scale_pub",
    slot: "scale_slot",
    subscription: "scale_sub",
  },
  reconcile: {
    tables: TABLES.map((name) => ({ name })),
    ...(WRITE_LOAD
      ? { ledgerPath: LEDGER_PATH, ledgerTable: "public.documents", ledgerIdColumn: "id" }
      : {}),
  },
  watchdog: { maxRetainedWalMb: WATCHDOG_MB, pollIntervalSec: 2, syncTimeoutMin: 60 },
});

const secrets = SecretsSchema.parse({
  SOURCE_DB_URL: process.env.TEST_SOURCE_DB_URL,
  TARGET_DB_URL: process.env.TEST_TARGET_DB_URL,
});

const since = (t0: number) => (performance.now() - t0) / 1000;
const fmt = (s: number) => `${s.toFixed(1)}s`;

async function main(): Promise<void> {
  const { source, target, close } = connect(secrets);
  log.toFile(`logs/scale-annoying-${ROWS}-${Date.now()}.log`);
  log.step(`pgshift scale run (annoying schema) — documents=${ROWS.toLocaleString()}`);

  await teardown(source, target, cfg);
  await createSchema(source);
  await createSchema(target);

  const tSeed = performance.now();
  await seedSource(source, ROWS);
  const [c] = await source.unsafe(
    `SELECT (SELECT count(*) FROM public.users)  +
            (SELECT count(*) FROM public.documents) +
            (SELECT count(*) FROM public.events) +
            (SELECT count(*) FROM public.audit)  AS n,
            (pg_total_relation_size('public.documents') + pg_total_relation_size('public.events')
             + pg_total_relation_size('public.users') + pg_total_relation_size('public.audit'))::bigint AS bytes`,
  );
  const rows = Number(c?.n ?? 0);
  const mib = Number(c?.bytes ?? 0) / 1_048_576;
  const seedS = since(tSeed);
  log.ok(
    `seeded ${rows.toLocaleString()} rows across 4 tables, ${mib.toFixed(0)} MiB in ${fmt(seedS)}`,
  );

  const tPre = performance.now();
  await preflight(source, target, cfg);
  const preS = since(tPre);

  const tRep = performance.now();
  await replicate(source, target, cfg, secrets);
  const repS = since(tRep);

  // WRITE_LOAD: start a concurrent INSERT/UPDATE/DELETE writer right after the
  // slot+subscription exist, so it loads the source THROUGH the initial copy.
  const ac = new AbortController();
  const writerP = WRITE_LOAD
    ? writer(source, {
        ledgerPath: LEDGER_PATH,
        intervalMs: WRITE_INTERVAL_MS,
        signal: ac.signal,
        trackRatio: 0.7,
      })
    : null;

  const tWatch = performance.now();
  await watch(source, target, cfg);
  const watchS = since(tWatch);

  let writeStats = "";
  if (writerP) {
    // keep writing after the copy completes to exercise pure streaming apply,
    // then stop writes ("app in read-only") BEFORE draining lag at cutover.
    await sleep(WRITE_AFTER_SEC * 1000);
    ac.abort();
    const w = await writerP;
    writeStats = `${w.inserts} ins / ${w.updates} upd / ${w.deletes} del (${w.tracked} tracked)`;
  }

  // Under load, reconcile is only authoritative AFTER cutover (lag drained to 0);
  // statically, order doesn't matter — keep the original report layout.
  let ok: boolean;
  let recS: number;
  let cutS: number;
  if (WRITE_LOAD) {
    const tCut = performance.now();
    await cutover(source, target, cfg, { maxLagWaitSec: 120 });
    cutS = since(tCut);
    const tRec = performance.now();
    ok = await reconcile(source, target, cfg); // includes the ledger inflight-loss check
    recS = since(tRec);
  } else {
    const tRec = performance.now();
    ok = await reconcile(source, target, cfg);
    recS = since(tRec);
    const tCut = performance.now();
    await cutover(source, target, cfg, { maxLagWaitSec: 120 });
    cutS = since(tCut);
  }

  await teardown(source, target, cfg);
  await close();

  log.step("scale report (annoying schema)");
  log.info(`rows (4 tables)    ${rows.toLocaleString()}`);
  log.info(`on-disk            ${mib.toFixed(0)} MiB`);
  log.info(`seed               ${fmt(seedS)}  (${(rows / seedS).toFixed(0)} rows/s)`);
  log.info(`preflight          ${fmt(preS)}`);
  log.info(`replicate setup    ${fmt(repS)}`);
  log.info(
    `initial copy       ${fmt(watchS)}  (${(mib / watchS).toFixed(1)} MiB/s, ${(rows / watchS).toFixed(0)} rows/s)`,
  );
  log.info(`reconcile          ${fmt(recS)}  -> ${ok ? "PASSED" : "FAILED"}`);
  log.info(`cutover            ${fmt(cutS)}`);
  if (WRITE_LOAD) {
    log.info(`write load         ${writeStats}`);
    log.info(`watchdog armed     ${WATCHDOG_MB} MB maxRetainedWal`);
  }
  log.info(`total e2e          ${fmt(seedS + preS + repS + watchS + recS + cutS)}`);
  if (!ok) {
    log.err("RECONCILE FAILED at scale");
    process.exitCode = 1;
  } else {
    log.ok("scale run complete — annoying schema reconciles clean");
  }
}

await main();
