import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the subscription's initial-sync state AND guard the source's WAL bloat.
 * Resolves when every table reaches srsubstate='r' (ready) and lag is ~0.
 * Throws if the slot retains more WAL than watchdog.maxRetainedWalMb — the
 * single most common way logical replication takes down the source.
 */
export async function watch(source: Db, target: Db, cfg: Config): Promise<void> {
  log.step("watch: initial sync + WAL watchdog");
  const { slot } = cfg.replication;
  const { maxRetainedWalMb, pollIntervalSec, syncTimeoutMin } = cfg.watchdog;
  const deadline = Date.now() + syncTimeoutMin * 60_000;

  for (;;) {
    // WAL retained by the slot on the source (bytes)
    const [walRow] = await source`
      SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes, active
      FROM pg_replication_slots WHERE slot_name = ${slot}`;
    const retainedMb = Number(walRow?.retained_bytes ?? 0) / 1_048_576;

    // Per-table sync state on the subscriber. srsubstate: i=init d=copying r=ready s=synced
    const states = await target`
      SELECT srsubstate, count(*)::int AS n
      FROM pg_subscription_rel GROUP BY srsubstate`;
    const byState = Object.fromEntries(states.map((s) => [s.srsubstate, s.n])) as Record<
      string,
      number
    >;
    const total = states.reduce((a, s) => a + Number(s.n), 0);
    const ready = Number(byState.r ?? 0);

    log.info(
      `sync ${ready}/${total} ready ` +
        `(init=${byState.i ?? 0} copy=${byState.d ?? 0} synced=${byState.s ?? 0}) | ` +
        `WAL retained ${retainedMb.toFixed(0)}MB | slot ${walRow?.active ? "active" : "INACTIVE"}`,
    );

    if (retainedMb > maxRetainedWalMb) {
      throw new Error(
        `WAL watchdog: slot retains ${retainedMb.toFixed(0)}MB > ${maxRetainedWalMb}MB limit. ` +
          "Subscriber is too slow or stalled — the source disk is at risk. Investigate before continuing.",
      );
    }

    if (total > 0 && ready === total) {
      log.ok(`all ${total} tables synced (srsubstate='r')`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`sync did not complete within ${syncTimeoutMin} min`);
    }
    await sleep(pollIntervalSec * 1000);
  }
}
