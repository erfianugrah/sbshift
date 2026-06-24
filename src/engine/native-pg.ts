import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { cutover } from "../steps/cutover.ts";
import { reconcile } from "../steps/reconcile.ts";
import { replicate } from "../steps/replicate.ts";
import { teardown } from "../steps/teardown.ts";
import { watch } from "../steps/watch.ts";
import type { CutoverOpts, ReconcileOpts, ReplicationEngine } from "./types.ts";

/**
 * Today's behaviour behind the ReplicationEngine seam — a thin delegator over the native
 * Postgres logical-replication steps (HETEROGENEOUS.md §3, impl A):
 *   - replicate: CREATE SUBSCRIPTION copy_data=true (consistent snapshot + CDC from one LSN)
 *   - watch:     poll pg_subscription_rel until initial sync, with the WAL watchdog
 *   - reconcile: row::text byte-hash across buckets
 *   - cutover:   LSN write-stop gate + sequence resync
 *   - teardown:  drop subscription / slot / publication
 * Zero behaviour change versus calling the step functions directly.
 */
export class NativePgEngine implements ReplicationEngine {
  readonly kind = "native-pg" as const;

  replicate(source: Db, target: Db, cfg: Config, secrets: Secrets): Promise<void> {
    return replicate(source, target, cfg, secrets);
  }

  watch(source: Db, target: Db, cfg: Config): Promise<void> {
    return watch(source, target, cfg);
  }

  reconcile(source: Db, target: Db, cfg: Config, opts: ReconcileOpts = {}): Promise<boolean> {
    return reconcile(source, target, cfg, opts);
  }

  cutover(source: Db, target: Db, cfg: Config, opts: CutoverOpts): Promise<void> {
    return cutover(source, target, cfg, opts);
  }

  teardown(source: Db, target: Db, cfg: Config): Promise<void> {
    return teardown(source, target, cfg);
  }
}
