import type { Db } from "../db.ts";
import { log } from "../log.ts";

/**
 * Seed the SOURCE documents table to a TARGET ON-DISK SIZE (not a row count) so a
 * rehearsal actually emulates prod scale. Generation is server-side
 * (INSERT...SELECT generate_series) in batches, with limited concurrency, so we
 * never pull data over the wire. Size is checked via pg_total_relation_size
 * between batches.
 *
 * expires_at is far-future (cron cleanup won't touch test data); user_id NULL
 * (no auth.users dependency).
 */
export async function seedToSize(
  source: Db,
  opts: { targetBytes: number; payloadBytes: number; batchRows: number; concurrency: number },
): Promise<void> {
  const gib = (opts.targetBytes / 1_073_741_824).toFixed(2);
  log.step(`seed documents to ~${gib} GiB (batch=${opts.batchRows}, conc=${opts.concurrency})`);
  const repeat = Math.max(1, Math.floor(opts.payloadBytes / 32));

  const insertBatch = async (db: Db) => {
    await db.unsafe(
      `INSERT INTO public.documents (content, title, language, expires_at, visibility)
       SELECT repeat(md5(random()::text), $1), 'seed', 'text',
              now() + interval '10 years', 'public'
       FROM generate_series(1, $2)`,
      [repeat, opts.batchRows],
    );
  };

  const tableSize = async (): Promise<number> => {
    const [r] = await source`SELECT pg_total_relation_size('public.documents')::bigint AS s`;
    return Number(r?.s ?? 0);
  };

  let size = await tableSize();
  let batches = 0;
  const t0 = Date.now();
  while (size < opts.targetBytes) {
    // fire `concurrency` batches in parallel, then re-check size
    await Promise.all(Array.from({ length: opts.concurrency }, () => insertBatch(source)));
    batches += opts.concurrency;
    size = await tableSize();
    const pct = ((size / opts.targetBytes) * 100).toFixed(1);
    const rate = (size / 1_048_576 / ((Date.now() - t0) / 1000)).toFixed(1);
    log.info(
      `${(size / 1_073_741_824).toFixed(2)} GiB (${pct}%) after ${batches} batches | ${rate} MiB/s`,
    );
  }
  const [c] = await source`SELECT count(*)::bigint AS n FROM public.documents`;
  log.ok(`seeded to ${(size / 1_073_741_824).toFixed(2)} GiB — ${c?.n} rows`);
}

/** Legacy row-count seed (small correctness runs). */
export async function seed(source: Db, rows: number, payloadBytes: number): Promise<void> {
  log.step(`seed ${rows} rows (~${payloadBytes}B each)`);
  const repeat = Math.max(1, Math.floor(payloadBytes / 32));
  await source.unsafe(
    `INSERT INTO public.documents (content, title, language, expires_at, visibility)
     SELECT repeat(md5(random()::text), $1), 'seed ' || g, 'text',
            now() + interval '10 years', 'public'
     FROM generate_series(1, $2) g`,
    [repeat, rows],
  );
  const [c] = await source`SELECT count(*)::bigint AS n FROM public.documents`;
  log.ok(`seeded — documents now has ${c?.n} rows`);
}
