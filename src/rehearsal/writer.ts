import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WriteLoadResult {
  inserts: number;
  updates: number;
  deletes: number;
  /** ids appended to the ledger — must all survive (the inflight-loss proof). */
  tracked: number;
}

/**
 * Continuous INSERT/UPDATE/DELETE load against the SOURCE `public.documents`
 * table, run THROUGH the migration to exercise the "inflight changes during
 * initial copy + streaming apply" risk — WAL retention, replication lag, and
 * the watch WAL-bloat watchdog. `reconcile` (after cutover, at lag=0) then
 * proves nothing was lost.
 *
 * Two id pools keep the inflight-loss proof valid alongside DELETEs:
 *   - tracked   ids are appended to the ledger and are NEVER deleted, so
 *     reconcile's ledger check can assert every one is present on the target.
 *   - ephemeral ids are never logged and are the only ones DELETEd, so DELETE
 *     replication is exercised without invalidating the ledger invariant.
 *
 * INSERT touches only `content` (NOT NULL in both the annoying and rehearsal
 * fixtures; everything else defaults/nullable), and id comparisons cast to text
 * so the same writer drives a uuid-PK or a bigint-IDENTITY-PK `documents`.
 *
 * Stop it at cutover: programmatically via `opts.signal` (harness), or
 * SIGINT/SIGTERM (Ctrl-C / docker stop) for the standalone `rehearse writer`.
 */
export async function writer(
  source: Db,
  opts: {
    ledgerPath: string;
    intervalMs: number;
    durationSec?: number;
    signal?: AbortSignal;
    /** fraction of inserts logged to the ledger (the rest are delete-eligible). */
    trackRatio?: number;
  },
): Promise<WriteLoadResult> {
  // C-3: create ledger directory before the first append — appendFileSync throws
  // ENOENT if the parent dir doesn't exist (e.g. on a clean clone).
  mkdirSync(dirname(opts.ledgerPath), { recursive: true });
  const trackRatio = opts.trackRatio ?? 0.7;
  log.step(
    `writer -> ${opts.ledgerPath} (every ${opts.intervalMs}ms, track=${Math.round(trackRatio * 100)}%)`,
  );
  const stopAt = opts.durationSec ? Date.now() + opts.durationSec * 1000 : Number.POSITIVE_INFINITY;

  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  let tracked = 0;
  const ephemeral: string[] = []; // un-logged ids, the only ones eligible for DELETE

  let running = true;
  // L-8: handle both SIGINT (Ctrl-C) and SIGTERM (docker stop / systemd / k8s),
  // plus an AbortSignal so a harness can stop the loop programmatically at cutover.
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  opts.signal?.addEventListener("abort", stop);

  while (running && !opts.signal?.aborted && Date.now() < stopAt) {
    const [row] = await source`
      INSERT INTO public.documents (content)
      VALUES (md5(random()::text))
      RETURNING id`;
    const id = String(row?.id);
    inserts++;
    if (Math.random() < trackRatio) {
      appendFileSync(opts.ledgerPath, `${id}\n`); // tracked: must survive to the target
      tracked++;
    } else {
      ephemeral.push(id);
    }
    // exercise UPDATE replication ~20% of the time
    if (Math.random() < 0.2) {
      await source`UPDATE public.documents SET title = 'edited' WHERE id::text = ${id}`;
      updates++;
    }
    // exercise DELETE replication ~15% of the time, only on un-logged ids
    if (ephemeral.length > 0 && Math.random() < 0.15) {
      const i = Math.floor(Math.random() * ephemeral.length);
      const victim = ephemeral[i] as string;
      ephemeral[i] = ephemeral[ephemeral.length - 1] as string; // swap-remove
      ephemeral.pop();
      await source`DELETE FROM public.documents WHERE id::text = ${victim}`;
      deletes++;
    }
    if (inserts % 100 === 0) log.info(`inserts=${inserts} updates=${updates} deletes=${deletes}`);
    await sleep(opts.intervalMs);
  }
  log.ok(
    `writer stopped — ${inserts} inserts, ${updates} updates, ${deletes} deletes (${tracked} tracked in ledger)`,
  );
  return { inserts, updates, deletes, tracked };
}
