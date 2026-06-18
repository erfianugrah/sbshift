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
