import type { Db } from "../db.ts";
import { log } from "../log.ts";

/**
 * Seed the SOURCE documents table with N rows for a rehearsal.
 * expires_at is set far in the future so the pg_cron cleanup job never deletes
 * test data mid-run (which would make the ledger reconciliation report phantom
 * losses). user_id is left NULL to avoid needing auth.users populated.
 */
export async function seed(source: Db, rows: number, payloadBytes: number): Promise<void> {
  log.step(`seed ${rows} rows (~${payloadBytes}B payload each)`);
  const repeat = Math.max(1, Math.floor(payloadBytes / 32));
  await source.unsafe(
    `INSERT INTO public.documents (content, title, language, expires_at, visibility)
     SELECT repeat(md5(random()::text), $1),
            'seed ' || g, 'text',
            now() + interval '10 years', 'public'
     FROM generate_series(1, $2) g`,
    [repeat, rows],
  );
  const [c] = await source`SELECT count(*)::bigint AS n FROM public.documents`;
  log.ok(`seeded — documents now has ${c?.n} rows`);
}
