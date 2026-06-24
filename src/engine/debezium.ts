import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { debeziumPlanFromConfig, renderDebeziumServerConfig } from "./debezium-config.ts";
import {
  debeziumContainerName,
  debeziumDataVolume,
  debeziumRmArgv,
  debeziumRunSpec,
  debeziumStopArgv,
  debeziumVolumeRmArgv,
} from "./debezium-runspec.ts";
import { DEBEZIUM_IMAGE, debeziumRuntimePin } from "./debezium-runtime.ts";
import type { CutoverOpts, ReconcileOpts, ReplicationEngine } from "./types.ts";

/**
 * The IO seam the DebeziumEngine drives — Docker process control + an HTTP health probe + file
 * staging. Injected so the orchestration logic (right argv, polls health, fails on timeout,
 * idempotent teardown) is unit-testable with mocks; the default impl is the real Bun/node IO.
 * The container spawn + Debezium itself are validated end-to-end by the Docker harness
 * (test/heterogeneous/), which the dev-box safety rule keeps out of the unit suite.
 */
export interface DebeziumIO {
  /** Run a command to completion, capturing stdout/stderr + exit code (never throws on non-zero). */
  exec(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** True iff a GET to `url` returns a 2xx (the Quarkus /q/health probe). */
  httpOk(url: string): Promise<boolean>;
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
  sleep(ms: number): Promise<void>;
}

export const defaultDebeziumIO: DebeziumIO = {
  async exec(argv) {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  },
  async httpOk(url) {
    try {
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  },
  writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Operational knobs resolved from the environment (an operational concern, not migration config). */
export interface DebeziumRuntimeOpts {
  stageDir: string;
  configPath: string;
  dataVolume: string;
  metricsPort: number;
  network?: string;
  image: string;
}

/** Pure: resolve the runtime opts for a migration from env + the topic prefix. */
export function resolveRuntimeOpts(
  env: Record<string, string | undefined>,
  topicPrefix: string,
): DebeziumRuntimeOpts {
  const stageDir = env.PGSHIFT_DBZ_STAGE_DIR ?? join(tmpdir(), `pgshift-dbz-${topicPrefix}`);
  const portRaw = env.PGSHIFT_DBZ_METRICS_PORT;
  const metricsPort = portRaw ? Number(portRaw) : 8080;
  if (!Number.isInteger(metricsPort) || metricsPort <= 0) {
    throw new Error(`PGSHIFT_DBZ_METRICS_PORT must be a positive integer, got '${portRaw}'`);
  }
  return {
    stageDir,
    configPath: join(stageDir, "application.properties"),
    dataVolume: env.PGSHIFT_DBZ_DATA_VOLUME ?? debeziumDataVolume(topicPrefix),
    metricsPort,
    network: env.PGSHIFT_DBZ_NETWORK || undefined,
    image: env.PGSHIFT_DBZ_IMAGE ?? DEBEZIUM_IMAGE,
  };
}

/**
 * The heterogeneous data-plane engine (HETEROGENEOUS.md §3, impl B): wraps a Debezium Server
 * process (MySQL binlog → JDBC sink → Postgres, no Kafka). The delivery vehicle is pinned
 * (debezium-runtime.ts) and the config + run-spec + reconcile renderers are unit-tested.
 *
 * Implemented: `replicate` (stage config + run the container + wait for health) and `teardown`
 * (stop/rm the container + drop the offset volume) — Debezium connects to MySQL itself, so these
 * never touch the `source` Db (which `connect()` builds as a Postgres client, useless for a
 * MySQL source). Their orchestration is unit-tested via the injected {@link DebeziumIO}; the
 * end-to-end path is validated by the Docker harness (test/heterogeneous/).
 *
 * Still gated (fail loud): `watch` (the Debezium Server metrics JSON shape must be confirmed
 * against a live server before parsing lag), and `reconcile` / `cutover` — both must query the
 * MySQL source DIRECTLY (aggregate scan; `SHOW MASTER STATUS` / GTID write-stop gate), which
 * needs a MySQL client dependency the project does not yet carry. That dependency choice is the
 * next decision.
 */
export class DebeziumEngine implements ReplicationEngine {
  readonly kind = "debezium" as const;

  constructor(private readonly io: DebeziumIO = defaultDebeziumIO) {}

  private notImplemented(method: string, why: string): never {
    throw new Error(
      `DebeziumEngine.${method} is not implemented yet — ${why}. The topology is proven ` +
        `(spike/debezium-mysql/, PASS) and the delivery vehicle is decided (${debeziumRuntimePin()}). ` +
        "See docs/HETEROGENEOUS.md §5.",
    );
  }

  /** Stage the rendered config, launch the Debezium container, and wait for it to report healthy. */
  async replicate(_source: Db, _target: Db, cfg: Config, secrets: Secrets): Promise<void> {
    const plan = debeziumPlanFromConfig(cfg, secrets); // throws for non-mysql sources
    const rt = resolveRuntimeOpts(process.env, plan.topicPrefix);
    const properties = renderDebeziumServerConfig(plan);

    log.step(`replicate (debezium) — ${debeziumRuntimePin()}`);
    this.io.mkdirp(rt.stageDir);
    this.io.writeFile(rt.configPath, properties); // contains secrets — 0600, never logged

    const spec = debeziumRunSpec({
      plan,
      configPath: rt.configPath,
      dataVolume: rt.dataVolume,
      metricsPort: rt.metricsPort,
      network: rt.network,
      image: rt.image,
    });
    log.detail(`launching ${spec.name} (${spec.image})`);
    const res = await this.io.exec(spec.argv);
    if (res.exitCode !== 0) {
      throw new Error(
        `docker run failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }

    await this.waitHealthy(spec.healthUrl, spec.name);
    log.ok(`${spec.name} healthy — snapshot + CDC streaming to the target`);
  }

  /** Poll the Quarkus health endpoint until 2xx, or throw after the budget elapses. */
  private async waitHealthy(
    healthUrl: string,
    name: string,
    attempts = 60,
    intervalMs = 2000,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (await this.io.httpOk(healthUrl)) return;
      await this.io.sleep(intervalMs);
    }
    throw new Error(
      `${name} did not become healthy at ${healthUrl} within ${(attempts * intervalMs) / 1000}s — ` +
        `inspect 'docker logs ${name}'.`,
    );
  }

  async watch(_source: Db, _target: Db, _cfg: Config): Promise<void> {
    this.notImplemented(
      "watch",
      "lag monitoring needs the Debezium Server metrics JSON shape confirmed against a live server",
    );
  }

  async reconcile(
    _source: Db,
    _target: Db,
    _cfg: Config,
    _opts: ReconcileOpts = {},
  ): Promise<boolean> {
    this.notImplemented(
      "reconcile",
      "the count+aggregate renderer is built (reconcile-aggregate.ts) but running it needs a " +
        "MySQL client to scan the source directly — a dependency decision",
    );
  }

  async cutover(_source: Db, _target: Db, _cfg: Config, _opts: CutoverOpts): Promise<void> {
    this.notImplemented(
      "cutover",
      "the MySQL write-stop gate (SHOW MASTER STATUS / GTID) needs a MySQL client — a dependency decision",
    );
  }

  /** Stop + remove the container and drop the persistent offset/schema-history volume. Idempotent. */
  async teardown(_source: Db, _target: Db, cfg: Config): Promise<void> {
    const name = debeziumContainerName(cfg.replication.publication);
    const volume = debeziumDataVolume(cfg.replication.publication);
    log.step(`teardown (debezium) — ${name}`);
    // stop is best-effort (container may already be stopped); rm -f tolerates a missing container.
    await this.io.exec(debeziumStopArgv(name));
    const rm = await this.io.exec(debeziumRmArgv(name));
    if (rm.exitCode !== 0 && !/no such container/i.test(rm.stderr)) {
      log.warn(`docker rm ${name} exit ${rm.exitCode}: ${rm.stderr.trim()}`);
    }
    const vol = await this.io.exec(debeziumVolumeRmArgv(volume));
    if (vol.exitCode !== 0 && !/no such volume/i.test(vol.stderr)) {
      log.warn(`docker volume rm ${volume} exit ${vol.exitCode}: ${vol.stderr.trim()}`);
    }
    log.ok(`torn down ${name} + volume ${volume}`);
  }
}
