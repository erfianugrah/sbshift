import { appendFileSync } from "node:fs";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Continuous write load against the SOURCE, appending every inserted id to an
 * append-only ledger file. Run this THROUGH the whole migration and stop it
 * (Ctrl-C) only at cutover — that is what exercises the "inflight changes
 * during initial copy" risk. `reconcile` later proves none were lost.
 */
export async function writer(
  source: Db,
  opts: { ledgerPath: string; intervalMs: number; durationSec?: number },
): Promise<void> {
  log.step(`writer -> ${opts.ledgerPath} (every ${opts.intervalMs}ms)`);
  const stopAt = opts.durationSec ? Date.now() + opts.durationSec * 1000 : Number.POSITIVE_INFINITY;
  let inserts = 0;
  let mutations = 0;
  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });

  while (running && Date.now() < stopAt) {
    const [row] = await source`
      INSERT INTO public.documents (content, expires_at, visibility)
      VALUES (md5(random()::text), now() + interval '10 years', 'public')
      RETURNING id`;
    const id = String(row?.id);
    appendFileSync(opts.ledgerPath, `${id}\n`);
    inserts++;
    // exercise UPDATE replication ~20% of the time
    if (Math.random() < 0.2) {
      await source`UPDATE public.documents SET title = 'edited' WHERE id = ${id}`;
      mutations++;
    }
    if (inserts % 100 === 0) log.info(`inserts=${inserts} updates=${mutations}`);
    await sleep(opts.intervalMs);
  }
  log.ok(`writer stopped — ${inserts} inserts, ${mutations} updates logged to ${opts.ledgerPath}`);
}
