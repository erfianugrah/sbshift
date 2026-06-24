import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { debeziumRuntimePin } from "./debezium-runtime.ts";
import type { CutoverOpts, ReconcileOpts, ReplicationEngine } from "./types.ts";

/**
 * The heterogeneous data-plane engine (HETEROGENEOUS.md §3, impl B): wraps a Debezium Server
 * process (MySQL binlog / SQL Server CDC → JDBC sink → Postgres, no Kafka). The topology is
 * proven end-to-end by spike/debezium-mysql/ (PASS); the config-rendering half lives in
 * `debezium-config.ts` and is unit-tested.
 *
 * The RUNTIME half — starting / watching / tearing down the container — is not built yet. The
 * delivery-vehicle question the spike's finding #1 raised is now DECIDED: pin the 3.6 pre-release
 * (see debezium-runtime.ts — 3.6 is the only line with the no-Kafka JDBC sink and is not yet
 * GA). The runtime build (container lifecycle, lag/offset watch, cutover write-stop gate) is the
 * remaining work; until it lands every lifecycle method fails loud rather than pretending to
 * migrate.
 *
 * Note the seam impedance to resolve when the runtime lands: `source` is typed `Db` (a Postgres
 * client), but a Debezium source is MySQL/SQL Server. The runtime will take the source
 * connection from new config fields, not this `Db`.
 */
export class DebeziumEngine implements ReplicationEngine {
  readonly kind = "debezium" as const;

  private notImplemented(method: string): never {
    throw new Error(
      `DebeziumEngine.${method} is not implemented yet. The MySQL→Postgres topology is proven ` +
        `(spike/debezium-mysql/, PASS) and the delivery vehicle is decided — ${debeziumRuntimePin()} ` +
        "— but the container runtime (lifecycle, watch, cutover gate) is not built. See " +
        "docs/HETEROGENEOUS.md §5.",
    );
  }

  // async so the throw surfaces as a rejected promise (the ReplicationEngine contract), not a
  // synchronous throw at the call site.
  async replicate(_source: Db, _target: Db, _cfg: Config, _secrets: Secrets): Promise<void> {
    this.notImplemented("replicate");
  }

  async watch(_source: Db, _target: Db, _cfg: Config): Promise<void> {
    this.notImplemented("watch");
  }

  async reconcile(
    _source: Db,
    _target: Db,
    _cfg: Config,
    _opts: ReconcileOpts = {},
  ): Promise<boolean> {
    this.notImplemented("reconcile");
  }

  async cutover(_source: Db, _target: Db, _cfg: Config, _opts: CutoverOpts): Promise<void> {
    this.notImplemented("cutover");
  }

  async teardown(_source: Db, _target: Db, _cfg: Config): Promise<void> {
    this.notImplemented("teardown");
  }
}
