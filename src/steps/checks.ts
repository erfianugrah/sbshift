/**
 * Shared SQL helpers used by both preflight.ts and doctor.ts.
 * Centralising here ensures C-1 (pg_has_role PG15 crash) is fixed once and
 * stays fixed — both callers import the same version-gated query builder.
 */

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";

/** Minimal emit interface so preflight (log.*) and doctor (Sink) can both drive the check. */
export interface CapacitySink {
  ok(msg: string): void;
  warn(msg: string): void;
}

/**
 * Replication-capacity GUC check (warn-only — never a hard fail).
 *
 * Catches the silent under-provisioning that bites managed Postgres in
 * particular: **Azure Database for PostgreSQL Flexible Server** ships a low
 * `max_worker_processes` by default, and logical apply/table-sync workers run
 * as background workers on the SUBSCRIBER — too few and the subscription stalls
 * with `out of background worker slots` (Azure's documented footgun). The slot/
 * sender checks catch a source that simply has no room to create the slot.
 *
 * Thresholds:
 *  - source `max_replication_slots` / `max_wal_senders`: must have headroom for
 *    the one slot+walsender this tool adds (warn if already saturated).
 *  - target `max_worker_processes` >= 16 (Azure's own recommended floor) and
 *    `max_logical_replication_workers` >= tables + 1 (parallel initial sync).
 */
export async function checkReplicationCapacity(
  source: Db,
  target: Db,
  cfg: Config,
  sink: CapacitySink,
): Promise<void> {
  const tables = cfg.replication.tables.length;

  const [src] = await source`
    SELECT current_setting('max_replication_slots')::int AS slots,
           current_setting('max_wal_senders')::int      AS senders,
           (SELECT count(*)::int FROM pg_replication_slots) AS used_slots,
           (SELECT count(*)::int FROM pg_stat_replication)   AS used_senders`;
  const slots = Number(src?.slots ?? 0);
  const senders = Number(src?.senders ?? 0);
  const usedSlots = Number(src?.used_slots ?? 0);
  const usedSenders = Number(src?.used_senders ?? 0);
  usedSlots < slots
    ? sink.ok(`source max_replication_slots=${slots} (${usedSlots} in use — room for the new slot)`)
    : sink.warn(
        `source max_replication_slots=${slots} but ${usedSlots} already in use — no room to create ` +
          `the slot. Raise max_replication_slots and restart.`,
      );
  if (senders <= usedSenders)
    sink.warn(
      `source max_wal_senders=${senders} with ${usedSenders} active — raise it (>= active + 1) so ` +
        `the slot can stream.`,
    );

  const [tgt] = await target`
    SELECT current_setting('max_worker_processes')::int            AS workers,
           current_setting('max_logical_replication_workers')::int AS lr_workers`;
  const workers = Number(tgt?.workers ?? 0);
  const lrWorkers = Number(tgt?.lr_workers ?? 0);
  workers >= 16
    ? sink.ok(`target max_worker_processes=${workers}`)
    : sink.warn(
        `target max_worker_processes=${workers} — raise to >= 16. Logical apply/table-sync run as ` +
          `background workers on the subscriber; too few stalls the subscription with ` +
          `"out of background worker slots" (Azure Flexible Server ships a low default).`,
      );
  if (lrWorkers < tables + 1)
    sink.warn(
      `target max_logical_replication_workers=${lrWorkers} for ${tables} tables — raise to >= ` +
        `${tables + 1} so initial table sync can parallelise (1 apply worker + N sync workers).`,
    );
}

/**
 * Version-gated SQL for the CREATE SUBSCRIPTION privilege check.
 *
 * `pg_create_subscription` is a PG16+ role; calling
 * `pg_has_role(current_user, 'pg_create_subscription', 'MEMBER')` on PG15
 * throws "role does not exist" before any version-guard branch is reached.
 * On PG15 we return `false` for has_grant and let the caller fall through to
 * the superuser check.
 */
export function subscribeGrantSQL(pgNum: number): string {
  return pgNum >= 160_000
    ? `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
              pg_has_role(current_user, 'pg_create_subscription', 'MEMBER') AS has_grant`
    : `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
              false AS has_grant`;
}
