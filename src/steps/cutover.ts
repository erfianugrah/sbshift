import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Final cutover. Caller MUST have already stopped application writes to the source.
 *  1. wait for replication lag -> 0
 *  2. (sequences) re-sync any sequences listed (none for uuid/text PKs)
 *  3. drop the subscription on the target
 *
 * Does NOT repoint your app or re-enable source writes — that is a human decision.
 * Never re-enable writes on the source afterwards (split-brain).
 */
export async function cutover(
  source: Db,
  target: Db,
  cfg: Config,
  opts: { sequences?: string[]; maxLagWaitSec?: number },
): Promise<void> {
  log.step("cutover");
  log.warn("Assuming application writes to the SOURCE are already stopped. If not, stop them now.");

  const { subscription, slot } = cfg.replication;
  const deadline = Date.now() + (opts.maxLagWaitSec ?? 300) * 1000;

  // 0. quiesce check: confirm the SOURCE is actually write-stopped before draining.
  //    If WAL is still advancing AND client backends are running write queries,
  //    writes are NOT stopped — draining to lag=0 is impossible and cutting over
  //    now would lose post-cutover writes. Warn loudly (autovacuum etc. can move
  //    WAL too, so this is a strong signal, not a hard stop).
  const [r1] = await source<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
  await sleep(1500);
  const [r2] = await source<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
  const lsn1 = r1?.lsn;
  const lsn2 = r2?.lsn;
  if (lsn1 !== lsn2) {
    const [w] = await source`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND state = 'active'
        AND pid <> pg_backend_pid()
        AND query !~* '^[[:space:]]*(select|copy|with|show|set|start_replication|fetch)'`;
    const n = w?.n ?? 0;
    log.warn(
      `source WAL still advancing (${lsn1} -> ${lsn2}) with ${n} active write-shaped ` +
        `client backend(s). Application writes do NOT appear stopped — draining to lag=0 ` +
        `may never complete, and any writes after this point will be LOST at cutover. ` +
        `Stop application writes to the source before proceeding.`,
    );
  } else {
    log.ok("source WAL quiescent — writes appear stopped");
  }

  // 1. drain lag
  for (;;) {
    const [row] = await source`
      SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
      FROM pg_replication_slots WHERE slot_name = ${slot}`;
    const lag = Number(row?.lag_bytes ?? 0);
    log.info(`replication lag ${(lag / 1024).toFixed(1)} KB`);
    if (lag <= 0) {
      log.ok("lag drained to zero");
      break;
    }
    if (Date.now() > deadline)
      throw new Error("lag did not drain in time — are writes really stopped?");
    await sleep(2000);
  }

  // 2. sequence re-sync (no-op for Example-app; present for the general case)
  for (const seq of opts.sequences ?? []) {
    log.warn(`sequence ${seq} must be resynced manually (setval) — generalised case only`);
  }

  // 3. drop subscription
  await target.unsafe(`DROP SUBSCRIPTION ${subscription}`);
  log.ok(`dropped subscription ${subscription}`);
  log.warn(
    "Now: repoint your app to the target, verify, and DO NOT re-enable writes on the source.",
  );
}
