import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { qi } from "../db.ts";
import { log } from "../log.ts";

/**
 * Tear everything down in the order that does NOT hang:
 *   target: disable + detach slot + drop subscription
 *   source: drop slot + drop publication
 * Safe to run repeatedly; missing objects are skipped.
 */
export async function teardown(source: Db, target: Db, cfg: Config): Promise<void> {
  log.step("teardown");
  const { subscription, slot, publication } = cfg.replication;

  const [sub] = await target`SELECT 1 FROM pg_subscription WHERE subname = ${subscription}`;
  if (sub) {
    // H-4: quote identifiers (same fix as replicate.ts / cutover.ts) so a
    // publication/subscription name with special chars tears down consistently.
    await target.unsafe(`ALTER SUBSCRIPTION ${qi(subscription)} DISABLE`);
    await target.unsafe(`ALTER SUBSCRIPTION ${qi(subscription)} SET (slot_name = NONE)`);
    await target.unsafe(`DROP SUBSCRIPTION ${qi(subscription)}`);
    log.ok(`dropped subscription ${subscription}`);
  } else {
    log.detail(`no subscription ${subscription}`);
  }

  const [s] = await source<{ active: boolean; active_pid: number | null }[]>`
    SELECT active, active_pid FROM pg_replication_slots WHERE slot_name = ${slot}`;
  if (s) {
    // The walsender backing a just-dropped subscription disconnects
    // asynchronously, so the slot can briefly remain "active for PID N" and
    // pg_drop_replication_slot() then errors. Terminate the lingering backend
    // (the subscription is already gone, so it is orphaned) and poll until the
    // slot releases before dropping it. Makes teardown deterministic.
    if (s.active && s.active_pid != null) {
      await source`SELECT pg_terminate_backend(${s.active_pid})`.catch(() => {});
    }
    for (let i = 0; i < 50; i++) {
      const [row] = await source<{ active: boolean }[]>`
        SELECT active FROM pg_replication_slots WHERE slot_name = ${slot}`;
      if (!row?.active) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await source`SELECT pg_drop_replication_slot(${slot})`;
    log.ok(`dropped slot ${slot}`);
  } else {
    log.detail(`no slot ${slot}`);
  }

  const [p] = await source`SELECT 1 FROM pg_publication WHERE pubname = ${publication}`;
  if (p) {
    await source.unsafe(`DROP PUBLICATION ${qi(publication)}`);
    log.ok(`dropped publication ${publication}`);
  } else {
    log.detail(`no publication ${publication}`);
  }
}
