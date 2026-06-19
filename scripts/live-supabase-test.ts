/**
 * End-to-end pgshift validation against a REAL throwaway Supabase project pair.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... bun run scripts/live-supabase-test.ts <org-id> [rows]
 *
 * Creates two throwaway projects (source + target, cross-region), loads the
 * annoying schema on both, seeds the source, runs the full pgshift pipeline
 * (doctor → preflight → replicate → watch → reconcile → cutover), asserts that
 * the resynced sequence prevents a post-cutover id collision, then DELETES both
 * projects. One command, repeatable, self-tearing-down.
 *
 * Designed to run from a host WITHOUT IPv6 to the direct hosts: admin/seed/
 * reconcile go through the IPv4 session pooler, and the subscription streams via
 * SOURCE_REPLICATION_URL (the source direct host, reached by the target's
 * walreceiver over Supabase's internal network). See README "Direct connection".
 *
 * Costs real money while the projects exist (a few minutes). The finally block
 * tears them down on any exit. Requires: SUPABASE_ACCESS_TOKEN in env.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import { connect } from "../src/db.ts";
import { log } from "../src/log.ts";
import { MgmtApi } from "../src/mgmt.ts";
import { cutover } from "../src/steps/cutover.ts";
import { doctor } from "../src/steps/doctor.ts";
import { preflight } from "../src/steps/preflight.ts";
import { reconcile } from "../src/steps/reconcile.ts";
import { replicate } from "../src/steps/replicate.ts";
import { watch } from "../src/steps/watch.ts";

// ---------------------------------------------------------------------------
// Args / env
// ---------------------------------------------------------------------------

const ORG_ID = process.argv[2];
if (!ORG_ID) {
  console.error("usage: bun run scripts/live-supabase-test.ts <org-id> [rows]");
  process.exit(1);
}
const ROWS = Number(process.argv[3] ?? 50_000);
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOKEN.startsWith("sbp_")) {
  console.error("SUPABASE_ACCESS_TOKEN (sbp_…) is required");
  process.exit(1);
}

const SRC_REGION = process.env.SRC_REGION ?? "eu-central-1";
const TGT_REGION = process.env.TGT_REGION ?? "eu-west-1";
const HERE = dirname(fileURLToPath(import.meta.url));

function randPw(): string {
  return randomBytes(21).toString("base64").replace(/[/+=]/g, "").slice(0, 28);
}

// ---------------------------------------------------------------------------
// Schema (pure SQL — no psql metacommands)
// ---------------------------------------------------------------------------

async function loadSchema(db: ReturnType<typeof connect>["source"]): Promise<void> {
  const sql = readFileSync(join(HERE, "annoying-schema.sql"), "utf8");
  await db.unsafe(sql);
}

// ---------------------------------------------------------------------------
// Seed — parameterised TS version of annoying-seed.sql
// (the .sql file uses psql \set / (:rows) which postgres.js can't execute)
// ---------------------------------------------------------------------------

async function seedSource(db: ReturnType<typeof connect>["source"]): Promise<void> {
  const N_USERS = Math.min(Math.max(Math.floor(ROWS / 10), 1_000), 50_000);
  const N_AUDIT = Math.max(Math.floor(ROWS / 10), 1_000);
  const BATCH = 50_000;

  await db.unsafe(
    `INSERT INTO public.users (n, email, display_name, metadata, tags, balance)
     SELECT g, 'user'||g||'@example.com',
            CASE WHEN g%7=0 THEN NULL ELSE 'Üsér '||g||' λ' END,
            jsonb_build_object('plan',(ARRAY['free','pro','team'])[1+g%3],'seq',g),
            ARRAY['t'||(g%5),'t'||(g%11)],
            (g*1.23456789)::numeric(20,8)
     FROM generate_series(1,$1::int) g`,
    [N_USERS],
  );

  for (let off = 0; off < ROWS; off += BATCH) {
    const n = Math.min(BATCH, ROWS - off);
    await db.unsafe(
      `WITH uids AS (SELECT array_agg(id ORDER BY n) AS a FROM public.users)
       INSERT INTO public.documents (owner,title,content,blob,status,views,ratio,ttl,ip)
       SELECT a[1+(g%$3)],
              CASE WHEN g%9=0 THEN NULL ELSE 'title '||g END,
              left(repeat(md5(random()::text),10),300)||' 日本語 '||g,
              decode(md5(g::text),'hex'),
              (ARRAY['active','archived','flagged','deleted']::doc_status[])[1+g%4],
              (g%1000),
              CASE WHEN g%5=0 THEN NULL ELSE random() END,
              ((g%48)||' hours')::interval,
              ('10.'||(g%256)||'.'||((g/256)%256)||'.'||(g%256))::inet
       FROM generate_series($1::bigint,$2::bigint) g, uids`,
      [off + 1, off + n, N_USERS],
    );
    if (off % (BATCH * 4) === 0 && off > 0)
      log.info(`seeded documents ${(off + n).toLocaleString()}/${ROWS.toLocaleString()}`);
  }

  for (let off = 0; off < ROWS; off += BATCH) {
    const n = Math.min(BATCH, ROWS - off);
    await db.unsafe(
      `INSERT INTO public.events (document_id,seq,kind,data)
       SELECT g,1,(ARRAY['create','view','edit'])[1+g%3],
              jsonb_build_object('g',g,'ok',(g%2=0))
       FROM generate_series($1::bigint,$2::bigint) g`,
      [off + 1, off + n],
    );
  }

  await db.unsafe(
    `INSERT INTO public.audit (actor,action,detail)
     SELECT gen_random_uuid(),(ARRAY['login','delete','update'])[1+g%3],
            CASE WHEN g%3=0 THEN NULL ELSE 'detail '||g END
     FROM generate_series(1,$1::int) g`,
    [N_AUDIT],
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const TABLES = ["public.users", "public.documents", "public.events", "public.audit"];

async function main(): Promise<void> {
  const api = new MgmtApi(TOKEN);
  let srcRef = "";
  let tgtRef = "";

  try {
    // ── Project creation ────────────────────────────────────────────────────
    log.step(`creating projects (src=${SRC_REGION} tgt=${TGT_REGION})`);
    const srcPw = randPw();
    const tgtPw = randPw();
    [srcRef, tgtRef] = await Promise.all([
      api.createProject("pgshift-livetest-src", ORG_ID, srcPw, SRC_REGION),
      api.createProject("pgshift-livetest-tgt", ORG_ID, tgtPw, TGT_REGION),
    ]);
    log.ok(`src=${srcRef}  tgt=${tgtRef}`);

    log.step("waiting for ACTIVE_HEALTHY (~2-4 min)");
    await api.waitHealthy([srcRef, tgtRef], { pollSec: 15, timeoutMin: 10 });
    // Pooler/postgres needs a few extra seconds after ACTIVE_HEALTHY
    await new Promise((r) => setTimeout(r, 20_000));

    // ── Connection strings ──────────────────────────────────────────────────
    const [srcPooler, tgtPooler] = await Promise.all([
      api.getPooler(srcRef),
      api.getPooler(tgtRef),
    ]);
    const srcPool = `postgresql://${srcPooler.user}:${srcPw}@${srcPooler.host}:5432/postgres?sslmode=require`;
    const tgtPool = `postgresql://${tgtPooler.user}:${tgtPw}@${tgtPooler.host}:5432/postgres?sslmode=require`;
    // Subscription must stream from the DIRECT host; target reaches it over
    // Supabase's internal network regardless of whether our host has IPv6.
    const srcDirect = `postgresql://postgres:${srcPw}@db.${srcRef}.supabase.co:5432/postgres?sslmode=require`;

    const secrets = SecretsSchema.parse({
      SOURCE_DB_URL: srcPool,
      TARGET_DB_URL: tgtPool,
      SOURCE_REPLICATION_URL: srcDirect,
      SUPABASE_ACCESS_TOKEN: TOKEN || undefined,
    });

    const cfg = ConfigSchema.parse({
      source: { ref: srcRef },
      target: { ref: tgtRef },
      replication: {
        publication: "pgshift_pub",
        slot: "pgshift_slot",
        subscription: "pgshift_sub",
        copyData: true,
        tables: TABLES,
      },
      reconcile: { tables: TABLES.map((name) => ({ name })) },
      watchdog: { maxRetainedWalMb: 4096, pollIntervalSec: 5, syncTimeoutMin: 30 },
    });

    const { source, target, close } = connect(secrets);

    try {
      // ── Schema + seed ──────────────────────────────────────────────────────
      log.step("loading annoying schema on both projects");
      await Promise.all([loadSchema(source), loadSchema(target)]);

      log.step(`seeding source (${ROWS.toLocaleString()} documents + deps)`);
      await seedSource(source);
      const [counts] = await source.unsafe(
        `SELECT (SELECT count(*) FROM public.users)  +
                (SELECT count(*) FROM public.documents) +
                (SELECT count(*) FROM public.events) +
                (SELECT count(*) FROM public.audit)  AS n`,
      );
      log.ok(`source has ${Number(counts?.n ?? 0).toLocaleString()} total rows`);

      // ── Pipeline ───────────────────────────────────────────────────────────
      log.step("doctor");
      await doctor(cfg, secrets);

      log.step("preflight");
      await preflight(source, target, cfg);

      log.step("replicate");
      await replicate(source, target, cfg, secrets);

      log.step("watch");
      await watch(source, target, cfg);

      log.step("reconcile");
      const ok = await reconcile(source, target, cfg);
      if (!ok) throw new Error("reconcile FAILED — data mismatch");

      log.step("cutover");
      await cutover(source, target, cfg, { maxLagWaitSec: 120 });

      // ── Post-cutover sequence-collision check ──────────────────────────────
      log.step("post-cutover sequence-collision check");
      const [row] = await target.unsafe(
        `INSERT INTO public.documents (content) VALUES ('post-cutover') RETURNING id`,
      );
      const newId = Number(row?.id);
      const expected = ROWS + 1;
      if (newId === expected) {
        log.ok(
          `new document id=${newId} (expected ${expected}) ✓ sequence resync prevented collision`,
        );
      } else {
        throw new Error(
          `sequence collision: got id=${newId} but expected ${expected} — resync failed`,
        );
      }

      log.ok("LIVE TEST PASSED — pipeline clean end-to-end against real Supabase");
    } finally {
      await close();
    }
  } finally {
    // ── Teardown — always runs, even on failure ────────────────────────────
    log.step("teardown — deleting throwaway projects");
    await Promise.allSettled(
      [srcRef, tgtRef]
        .filter(Boolean)
        .map((ref) => api.deleteProject(ref).then(() => log.ok(`deleted ${ref}`))),
    );
  }
}

await main();
