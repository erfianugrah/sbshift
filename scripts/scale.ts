/**
 * Scale harness — NOT a unit test. Seeds a generic table to ROWS rows on the
 * source, then runs the real pipeline (replicate → watch → reconcile → cutover)
 * with per-phase wall-clock timing and a throughput report. Engine-only: no
 * Supabase, no gen-column bottleneck — a clean throughput number for pgshift.
 *
 * Run inside the test compose network (service-DNS source:/target:):
 *   docker compose -f docker-compose.test.yml run --rm \
 *     -e ROWS=1000000 -e PAYLOAD_CHARS=512 runner \
 *     sh -c 'bun install --frozen-lockfile && bun run scripts/scale.ts'
 */
import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { log } from "../src/log.ts";
import { cutover } from "../src/steps/cutover.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { teardown } from "../src/steps/teardown.ts";
import { watch } from "../src/steps/watch.ts";

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const PAYLOAD_CHARS = Number(process.env.PAYLOAD_CHARS ?? 512);
const TABLE = "public.scale";

const cfg = ConfigSchema.parse({
  source: { ref: "a".repeat(20) },
  target: { ref: "b".repeat(20) },
  replication: {
    tables: [TABLE],
    publication: "scale_pub",
    slot: "scale_slot",
    subscription: "scale_sub",
  },
  reconcile: { tables: [{ name: TABLE }] },
  watchdog: { maxRetainedWalMb: 50_000_000, pollIntervalSec: 2, syncTimeoutMin: 60 },
});

const secrets = SecretsSchema.parse({
  SOURCE_DB_URL: process.env.TEST_SOURCE_DB_URL,
  TARGET_DB_URL: process.env.TEST_TARGET_DB_URL,
});

const since = (t0: number) => (performance.now() - t0) / 1000;
const fmt = (s: number) => `${s.toFixed(1)}s`;

async function createSchema(db: Db): Promise<void> {
  await db.unsafe(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  // Wide-ish realistic row, a secondary index, an owned sequence (seq_id) so the
  // cutover sequence-resync path runs. No generated column (that is the known
  // CPU bottleneck; excluded here for a clean throughput number).
  await db.unsafe(`CREATE TABLE ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq_id bigserial,
    email text NOT NULL,
    payload text NOT NULL,
    n int NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.unsafe(`CREATE INDEX ${TABLE.split(".")[1]}_email_idx ON ${TABLE} (email)`);
}

async function main(): Promise<void> {
  const { source, target, close } = connect(secrets);
  log.toFile(`logs/scale-${ROWS}-${Date.now()}.log`);
  log.step(`pgshift scale run — ${ROWS.toLocaleString()} rows, ~${PAYLOAD_CHARS}B payload`);

  await teardown(source, target, cfg);
  await createSchema(source);
  await createSchema(target);

  // ── seed ──────────────────────────────────────────────────────────────
  const tSeed = performance.now();
  const BATCH = 50_000;
  // repeat 32-char md5 to ~PAYLOAD_CHARS; built in SQL so we don't ship payloads over the wire
  const reps = Math.max(1, Math.ceil(PAYLOAD_CHARS / 32));
  for (let off = 0; off < ROWS; off += BATCH) {
    const n = Math.min(BATCH, ROWS - off);
    await source.unsafe(
      `INSERT INTO ${TABLE} (email, payload, n)
       SELECT 'user' || g || '@example.com',
              left(repeat(md5(random()::text), ${reps}), ${PAYLOAD_CHARS}),
              g
       FROM generate_series($1::bigint, $2::bigint) g`,
      [off + 1, off + n],
    );
    if ((off / BATCH) % 4 === 0)
      log.info(`seeded ${(off + n).toLocaleString()}/${ROWS.toLocaleString()}`);
  }
  const [c] = await source.unsafe(
    `SELECT count(*)::bigint AS n, pg_total_relation_size('${TABLE}')::bigint AS bytes FROM ${TABLE}`,
  );
  const rows = Number(c?.n ?? 0);
  const mib = Number(c?.bytes ?? 0) / 1_048_576;
  const seedS = since(tSeed);
  log.ok(`seeded ${rows.toLocaleString()} rows, ${mib.toFixed(0)} MiB on source in ${fmt(seedS)}`);

  // ── replicate ─────────────────────────────────────────────────────────
  const tRep = performance.now();
  await replicate(source, target, cfg, secrets);
  const repS = since(tRep);

  // ── watch (initial copy) ────────────────────────────────────────────────
  const tWatch = performance.now();
  await watch(source, target, cfg);
  const watchS = since(tWatch);

  // ── reconcile ───────────────────────────────────────────────────────────
  const tRec = performance.now();
  const ok = await reconcile(source, target, cfg);
  const recS = since(tRec);

  // ── cutover (quiesce + lag drain + sequence resync + drop sub) ───────────
  const tCut = performance.now();
  await cutover(source, target, cfg, { maxLagWaitSec: 120 });
  const cutS = since(tCut);

  await teardown(source, target, cfg);
  await close();

  // ── report ────────────────────────────────────────────────────────────
  const copyMiBs = mib / watchS;
  log.step("scale report");
  log.info(`rows               ${rows.toLocaleString()}`);
  log.info(`on-disk            ${mib.toFixed(0)} MiB`);
  log.info(`seed               ${fmt(seedS)}  (${(rows / seedS).toFixed(0)} rows/s)`);
  log.info(`replicate setup    ${fmt(repS)}`);
  log.info(
    `initial copy       ${fmt(watchS)}  (${copyMiBs.toFixed(1)} MiB/s, ${(rows / watchS).toFixed(0)} rows/s)`,
  );
  log.info(`reconcile          ${fmt(recS)}  -> ${ok ? "PASSED" : "FAILED"}`);
  log.info(`cutover            ${fmt(cutS)}`);
  log.info(`total e2e          ${fmt(seedS + repS + watchS + recS + cutS)}`);
  if (!ok) {
    log.err("RECONCILE FAILED at scale");
    process.exitCode = 1;
  } else {
    log.ok("scale run complete — reconcile clean");
  }
}

await main();
