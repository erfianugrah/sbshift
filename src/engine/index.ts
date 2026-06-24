import type { Config } from "../config.ts";
import { NativePgEngine } from "./native-pg.ts";
import type { ReplicationEngine } from "./types.ts";

export { NativePgEngine } from "./native-pg.ts";
export type { CutoverOpts, EngineKind, ReconcileOpts, ReplicationEngine } from "./types.ts";

/**
 * Pick the data-plane engine for a migration (HETEROGENEOUS.md §3).
 *
 * Today every pgshift source is native Postgres, so this always returns NativePgEngine. When
 * the Debezium impl lands (HETEROGENEOUS.md §5), this is the single dispatch point: it will
 * key off the source engine declared in config (e.g. a future `cfg.source.engine === "mysql"`)
 * and return a DebeziumEngine instead. Centralising the choice here keeps every caller —
 * `run` and the individual CLI commands — engine-agnostic.
 */
export function engineFor(_cfg: Config): ReplicationEngine {
  return new NativePgEngine();
}
