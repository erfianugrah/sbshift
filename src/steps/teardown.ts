import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
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
    await target.unsafe(`ALTER SUBSCRIPTION ${subscription} DISABLE`);
    await target.unsafe(`ALTER SUBSCRIPTION ${subscription} SET (slot_name = NONE)`);
    await target.unsafe(`DROP SUBSCRIPTION ${subscription}`);
    log.ok(`dropped subscription ${subscription}`);
  } else {
    log.detail(`no subscription ${subscription}`);
  }

  const [s] = await source`SELECT 1 FROM pg_replication_slots WHERE slot_name = ${slot}`;
  if (s) {
    await source`SELECT pg_drop_replication_slot(${slot})`;
    log.ok(`dropped slot ${slot}`);
  } else {
    log.detail(`no slot ${slot}`);
  }

  const [p] = await source`SELECT 1 FROM pg_publication WHERE pubname = ${publication}`;
  if (p) {
    await source.unsafe(`DROP PUBLICATION ${publication}`);
    log.ok(`dropped publication ${publication}`);
  } else {
    log.detail(`no publication ${publication}`);
  }
}
