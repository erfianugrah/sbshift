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
 *     sh -c 'bun install --frozen-lockfile && bun run scripts/scale.ts'
 *
 * ROWS sizes the documents (gen-column) table; users/events/audit scale off it.
 */
import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import { connect, type Db } from "../src/db.ts";
import { log } from "../src/log.ts";
import { cutover } from "../src/steps/cutover.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { teardown } from "../src/steps/teardown.ts";
import { watch } from "../src/steps/watch.ts";

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const PAYLOAD_CHARS = Number(process.env.PAYLOAD_CHARS ?? 300);
const N_USERS = Math.min(Math.max(Math.floor(ROWS / 100), 1_000), 50_000);
const N_AUDIT = Math.floor(ROWS / 10);

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
  reconcile: { tables: TABLES.map((name) => ({ name })) },
  watchdog: { maxRetainedWalMb: 50_000_000, pollIntervalSec: 2, syncTimeoutMin: 60 },
});

const secrets = SecretsSchema.parse({
  SOURCE_DB_URL: process.env.TEST_SOURCE_DB_URL,
  TARGET_DB_URL: process.env.TEST_TARGET_DB_URL,
});

const since = (t0: number) => (performance.now() - t0) / 1000;
const fmt = (s: number) => `${s.toFixed(1)}s`;

async function createSchema(db: Db): Promise<void> {
  await db.unsafe(`
    DROP TABLE IF EXISTS public.events CASCADE;
    DROP TABLE IF EXISTS public.documents CASCADE;
    DROP TABLE IF EXISTS public.audit  CASCADE;
    DROP TABLE IF EXISTS public.users  CASCADE;
    DROP TYPE  IF EXISTS doc_status  CASCADE;
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE TYPE doc_status AS ENUM ('active','archived','flagged','deleted');

    -- parent: uuid pk, citext unique, jsonb, array, numeric, n for fast FK join
    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      n int UNIQUE NOT NULL,
      email citext UNIQUE NOT NULL,
      display_name text,
      metadata jsonb NOT NULL DEFAULT '{}',
      tags text[] NOT NULL DEFAULT '{}',
      balance numeric(20,8) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- heavy child: IDENTITY pk (owned sequence), FK→users, STORED tsvector,
    -- bytea/numeric/float/interval/inet/enum + nullable columns + unicode content
    CREATE TABLE public.documents (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner uuid REFERENCES public.users(id),
      title text,
      content text NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content,''))) STORED,
      blob bytea,
      status doc_status NOT NULL DEFAULT 'active',
      views int NOT NULL DEFAULT 0,
      ratio double precision,
      ttl interval,
      ip inet,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- composite pk + FK→documents
    CREATE TABLE public.events (
      document_id bigint NOT NULL REFERENCES public.documents(id),
      seq int NOT NULL,
      kind text NOT NULL,
      data jsonb,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, seq)
    );

    -- NO pk → must use REPLICA IDENTITY FULL or UPDATE/DELETE won't replicate
    CREATE TABLE public.audit (
      actor uuid,
      action text NOT NULL,
      detail text,
      at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.audit REPLICA IDENTITY FULL;
  `);
}

async function seedSource(source: Db): Promise<void> {
  const reps = Math.max(1, Math.ceil(PAYLOAD_CHARS / 32));
  // users
  await source.unsafe(
    `INSERT INTO public.users (n, email, display_name, metadata, tags, balance)
     SELECT g, 'user' || g || '@example.com',
            CASE WHEN g % 7 = 0 THEN NULL ELSE 'Üsér ' || g || ' λ' END,
            jsonb_build_object('plan', (ARRAY['free','pro','team'])[1 + g % 3], 'seq', g),
            ARRAY['t' || (g % 5), 't' || (g % 11)],
            (g * 1.23456789)::numeric(20,8)
     FROM generate_series(1, $1::int) g`,
    [N_USERS],
  );
  // documents (the bulk + gen column), FK owner via O(1) array index into users
  const BATCH = 50_000;
  for (let off = 0; off < ROWS; off += BATCH) {
    const n = Math.min(BATCH, ROWS - off);
    await source.unsafe(
      `WITH uids AS (SELECT array_agg(id ORDER BY n) AS a FROM public.users)
       INSERT INTO public.documents (owner, title, content, blob, status, views, ratio, ttl, ip)
       SELECT a[1 + (g % $3)],
              CASE WHEN g % 9 = 0 THEN NULL ELSE 'title ' || g END,
              left(repeat(md5(random()::text), ${reps}), ${PAYLOAD_CHARS}) || ' 日本語 ' || g,
              decode(md5(g::text), 'hex'),
              (ARRAY['active','archived','flagged','deleted']::doc_status[])[1 + g % 4],
              (g % 1000),
              CASE WHEN g % 5 = 0 THEN NULL ELSE random() END,
              ((g % 48) || ' hours')::interval,
              ('10.' || (g % 256) || '.' || ((g / 256) % 256) || '.' || (g % 256))::inet
       FROM generate_series($1::bigint, $2::bigint) g, uids`,
      [off + 1, off + n, N_USERS],
    );
    if ((off / BATCH) % 4 === 0)
      log.info(`seeded documents ${(off + n).toLocaleString()}/${ROWS.toLocaleString()}`);
  }
  // events: one per document (document ids are 1..ROWS from the identity sequence)
  for (let off = 0; off < ROWS; off += BATCH) {
    const n = Math.min(BATCH, ROWS - off);
    await source.unsafe(
      `INSERT INTO public.events (document_id, seq, kind, data)
       SELECT g, 1, (ARRAY['create','view','edit'])[1 + g % 3],
              jsonb_build_object('g', g, 'ok', (g % 2 = 0))
       FROM generate_series($1::bigint, $2::bigint) g`,
      [off + 1, off + n],
    );
  }
  // audit (no pk)
  await source.unsafe(
    `INSERT INTO public.audit (actor, action, detail)
     SELECT gen_random_uuid(), (ARRAY['login','delete','update'])[1 + g % 3],
            CASE WHEN g % 3 = 0 THEN NULL ELSE 'detail ' || g END
     FROM generate_series(1, $1::int) g`,
    [N_AUDIT],
  );
}

async function main(): Promise<void> {
  const { source, target, close } = connect(secrets);
  log.toFile(`logs/scale-annoying-${ROWS}-${Date.now()}.log`);
  log.step(
    `pgshift scale run (annoying schema) — documents=${ROWS.toLocaleString()} users=${N_USERS.toLocaleString()} events=${ROWS.toLocaleString()} audit=${N_AUDIT.toLocaleString()}`,
  );

  await teardown(source, target, cfg);
  await createSchema(source);
  await createSchema(target);

  const tSeed = performance.now();
  await seedSource(source);
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

  const tWatch = performance.now();
  await watch(source, target, cfg);
  const watchS = since(tWatch);

  const tRec = performance.now();
  const ok = await reconcile(source, target, cfg);
  const recS = since(tRec);

  const tCut = performance.now();
  await cutover(source, target, cfg, { maxLagWaitSec: 120 });
  const cutS = since(tCut);

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
  log.info(`total e2e          ${fmt(seedS + preS + repS + watchS + recS + cutS)}`);
  if (!ok) {
    log.err("RECONCILE FAILED at scale");
    process.exitCode = 1;
  } else {
    log.ok("scale run complete — annoying schema reconciles clean");
  }
}

await main();
