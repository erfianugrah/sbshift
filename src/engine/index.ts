import type { Config } from "../config.ts";
import { NativePgEngine } from "./native-pg.ts";
import type { ReplicationEngine } from "./types.ts";

export { NativePgEngine } from "./native-pg.ts";
export type { CutoverOpts, EngineKind, ReconcileOpts, ReplicationEngine } from "./types.ts";

/**
 * Pick the data-plane engine for a migration (HETEROGENEOUS.md §3).
 *
 * Dispatches on the source engine declared in config. `postgres` — the default, and today's
 * only working path — maps to native logical replication (`NativePgEngine`). The heterogeneous
 * engines (`mysql`, `sqlserver`) map to the Debezium CDC impl, which isn't built yet
 * (HETEROGENEOUS.md §5); they fail loud here rather than silently running the native path on a
 * source that can't speak it. Centralising the choice keeps every caller — `run` and the
 * individual CLI commands — engine-agnostic.
 */
export function engineFor(cfg: Config): ReplicationEngine {
  switch (cfg.source.engine) {
    case "postgres":
      return new NativePgEngine();
    case "mysql":
    case "sqlserver":
      throw new Error(
        `source.engine="${cfg.source.engine}" needs the Debezium replication engine, which is not implemented yet (see docs/HETEROGENEOUS.md §5). Only "postgres" sources are supported today.`,
      );
  }
}
