import type { Config } from "../config.ts";
import { DebeziumEngine } from "./debezium.ts";
import { NativePgEngine } from "./native-pg.ts";
import type { ReplicationEngine } from "./types.ts";

export { DebeziumEngine } from "./debezium.ts";
export { NativePgEngine } from "./native-pg.ts";
export type { CutoverOpts, EngineKind, ReconcileOpts, ReplicationEngine } from "./types.ts";

/**
 * Pick the data-plane engine for a migration (HETEROGENEOUS.md §3).
 *
 * Dispatches on the source engine declared in config. `postgres` (the default) maps to native
 * logical replication (`NativePgEngine`). The heterogeneous engines (`mysql`, `sqlserver`) map to
 * the `DebeziumEngine`. The full mysql lifecycle is implemented + harness-verified
 * (test/heterogeneous/, PASS); `sqlserver` is the next engine (HETEROGENEOUS.md §6) and its
 * lifecycle methods fail loud until it lands. Dispatching here (rather than at each call site)
 * keeps every caller engine-agnostic.
 */
export function engineFor(cfg: Config): ReplicationEngine {
  switch (cfg.source.engine) {
    case "postgres":
      return new NativePgEngine();
    case "mysql":
    case "sqlserver":
      return new DebeziumEngine();
  }
}
