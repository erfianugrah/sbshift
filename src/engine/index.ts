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
 * Dispatches on the source engine declared in config. `postgres` — the default, and today's
 * only working path — maps to native logical replication (`NativePgEngine`). The heterogeneous
 * engines (`mysql`, `sqlserver`) map to the `DebeziumEngine`: its config rendering is real and
 * tested, but its lifecycle methods fail loud (the container runtime is gated on the
 * delivery-vehicle decision — HETEROGENEOUS.md §5, spike finding #1). Returning the engine here
 * rather than throwing keeps the seam structurally complete and every caller engine-agnostic;
 * the loud failure surfaces at the first lifecycle call instead.
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
