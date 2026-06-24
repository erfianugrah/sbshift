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
import { connectMySql, type MySqlConn } from "./mysql.ts";
import {
  type AggColumn,
  categorizePgType,
  parseAggregateRow,
  reconcileAggregateReport,
  renderAggregateQuery,
} from "./reconcile-aggregate.ts";
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
  /** True iff a GET to `url` returns a 2xx (the Quarkus /q/health readiness probe). */
  httpOk(url: string): Promise<boolean>;
  /** GET returning status + body, or null on a network error (for parsing /q/health JSON). */
  httpText(url: string): Promise<{ ok: boolean; status: number; body: string } | null>;
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
  async httpText(url) {
    try {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch {
      return null;
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

  constructor(
    private readonly io: DebeziumIO = defaultDebeziumIO,
    /** Injected for tests; defaults to the real mysql2-backed connector. */
    private readonly mysqlConnect: (url: string) => Promise<MySqlConn> = connectMySql,
  ) {}

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

  /**
   * Watch the heterogeneous initial sync to completion. With this image there is NO HTTP metrics
   * endpoint (/q/metrics is 404) — only /q/health, which carries a `debezium` connector check.
   * So watch resolves on the two OBSERVABLE signals: the connector stays healthy (abort loud if it
   * goes DOWN or the endpoint is unreachable), and source/target row counts converge (the
   * catch-up analogue of the native "reach srsubstate='r' + lag~0"). Bounded by
   * watchdog.syncTimeoutMin; polls every watchdog.pollIntervalSec.
   */
  async watch(_source: Db, target: Db, cfg: Config): Promise<void> {
    if (cfg.source.engine !== "mysql") {
      this.notImplemented("watch", "only mysql sources are rendered yet (HETEROGENEOUS.md §6)");
    }
    const url = process.env.SOURCE_DB_URL;
    if (!url) throw new Error("watch (debezium): SOURCE_DB_URL is required");
    const name = debeziumContainerName(cfg.replication.publication);
    const rt = resolveRuntimeOpts(process.env, cfg.replication.publication);
    const healthUrl = `http://localhost:${rt.metricsPort}/q/health`;
    const interval = cfg.watchdog.pollIntervalSec * 1000;
    const deadline = Date.now() + cfg.watchdog.syncTimeoutMin * 60_000;
    log.step("watch (debezium) — connector health + initial-sync catch-up");

    const my = await this.mysqlConnect(url);
    let unreachable = 0;
    try {
      for (;;) {
        const res = await this.io.httpText(healthUrl);
        if (!res) {
          if (++unreachable >= 5) {
            throw new Error(
              `Debezium health endpoint ${healthUrl} unreachable ${unreachable}x — is the ` +
                `container running? (docker logs ${name})`,
            );
          }
        } else {
          unreachable = 0;
          const h = parseDebeziumHealth(res.body);
          if (!h.debeziumUp) {
            throw new Error(
              `Debezium connector reports DOWN (${healthUrl}) — the connector has failed; ` +
                `inspect: docker logs ${name}`,
            );
          }
        }

        let caughtUp = true;
        const progress: string[] = [];
        for (const t of cfg.reconcile.tables) {
          const [db, tbl] = t.name.split(".") as [string, string];
          const [s] = await my.query<{ n: string }>(
            `SELECT count(*) AS n FROM \`${db}\`.\`${tbl}\``,
          );
          const [tg] = (await target.unsafe(
            `SELECT count(*)::bigint AS n FROM "public"."${tbl}"`,
          )) as { n: string }[];
          progress.push(`${t.name} ${tg?.n ?? "?"}/${s?.n ?? "?"}`);
          if (String(s?.n) !== String(tg?.n)) caughtUp = false;
        }
        if (caughtUp) {
          log.ok(`initial sync caught up (${progress.join(", ")})`);
          return;
        }
        log.info(`syncing: ${progress.join(", ")}`);
        if (Date.now() > deadline) {
          throw new Error("initial sync did not catch up within watchdog.syncTimeoutMin");
        }
        await this.io.sleep(interval);
      }
    } finally {
      await my.end();
    }
  }

  /**
   * Cross-engine reconcile (HETEROGENEOUS.md §2 item 7): count + portable per-column aggregates
   * computed on the MySQL source and the PG target in each dialect, then diffed. NOT byte-exact —
   * the report carries that caveat and it is logged loudly. Columns + categories are introspected
   * from the TARGET (the post-migration source of truth); source uses `<db>.<table>`, target uses
   * `public.<table>` (the bare name Debezium's RegexRouter lands rows under).
   */
  async reconcile(
    _source: Db,
    target: Db,
    cfg: Config,
    opts: ReconcileOpts = {},
  ): Promise<boolean> {
    if (cfg.source.engine !== "mysql") {
      this.notImplemented("reconcile", "only mysql sources are rendered yet (HETEROGENEOUS.md §6)");
    }
    const url = process.env.SOURCE_DB_URL;
    if (!url)
      throw new Error("reconcile (debezium): SOURCE_DB_URL is required to scan the MySQL source");

    log.step("reconcile (debezium — count + portable aggregates, NOT a byte-exact row hash)");
    const my = await this.mysqlConnect(url);
    const reports = [];
    try {
      for (const t of cfg.reconcile.tables) {
        const [db, tbl] = t.name.split(".") as [string, string];
        const cols = await targetAggColumns(target, "public", tbl);
        if (cols.length === 0) {
          log.err(`${t.name}: no non-generated columns on target public.${tbl}`);
          return false;
        }
        const myRows = await my.query(renderAggregateQuery("mysql", db, tbl, cols));
        const pgRows = (await target.unsafe(
          renderAggregateQuery("postgres", "public", tbl, cols),
        )) as Record<string, unknown>[];
        const report = reconcileAggregateReport(
          t.name,
          parseAggregateRow(myRows[0] ?? {}, cols),
          parseAggregateRow(pgRows[0] ?? {}, cols),
        );
        reports.push(report);
        const head = `${t.name}: src=${report.sourceRows} tgt=${report.targetRows}`;
        if (report.match) {
          log.ok(head);
        } else {
          log.err(`${head} | ${report.mismatches.length} mismatch(es)`);
          for (const m of report.mismatches) log.detail(JSON.stringify(m));
        }
      }
    } finally {
      await my.end();
    }

    if (reports[0]) log.warn(reports[0].caveat); // say the downgrade out loud
    const outDir = opts.outDir ?? "ledger";
    this.io.mkdirp(outDir);
    this.io.writeFile(
      `${outDir}/reconcile-debezium-${Date.now()}.json`,
      JSON.stringify(reports, null, 2),
    );

    const allMatch = reports.every((r) => r.match);
    allMatch
      ? log.ok(
          "RECONCILE PASSED — source and target aggregates match (within the downgrade caveat)",
        )
      : log.err("RECONCILE FAILED — see mismatches above");
    return allMatch;
  }

  /**
   * Fail-closed cutover (mirrors the native LSN gate): (0) confirm the MySQL source is
   * write-stopped by checking the binlog position is stable; (1) drain — poll until source/target
   * row counts converge (writes are stopped, so CDC will catch up); (2) resync any target
   * identity/serial sequence to the source's MAX (Debezium upserts explicit PKs, so a stuck
   * sequence would collide on the next local insert); (3) stop the Debezium container (the
   * analogue of dropping the subscription). Caller MUST have already stopped application writes.
   */
  async cutover(_source: Db, target: Db, cfg: Config, opts: CutoverOpts): Promise<void> {
    if (cfg.source.engine !== "mysql") {
      this.notImplemented("cutover", "only mysql sources are rendered yet (HETEROGENEOUS.md §6)");
    }
    const url = process.env.SOURCE_DB_URL;
    if (!url) throw new Error("cutover (debezium): SOURCE_DB_URL is required");
    log.step("cutover (debezium) — MySQL write-stop gate + identity resync");
    log.warn(
      "Assuming application writes to the SOURCE MySQL are already stopped. If not, stop them now.",
    );

    const my = await this.mysqlConnect(url);
    try {
      // 0. write-stop gate: the binlog position must be stable across a short window.
      const pos1 = await binlogPosition(my);
      await this.io.sleep(2000);
      const pos2 = await binlogPosition(my);
      if (pos1 !== pos2) {
        throw new Error(
          `source binlog still advancing (${pos1} -> ${pos2}) — writes to the MySQL source are NOT ` +
            "stopped. Stop them before cutover; any write after this point would be LOST.",
        );
      }
      log.ok(`source binlog stable at ${pos1} — writes appear stopped`);

      // 1. drain: poll until row counts converge (no precise offset needed once writes are stopped).
      const deadline = Date.now() + (opts.maxLagWaitSec ?? 300) * 1000;
      for (;;) {
        let converged = true;
        for (const t of cfg.reconcile.tables) {
          const [db, tbl] = t.name.split(".") as [string, string];
          const [s] = await my.query<{ n: string }>(
            `SELECT count(*) AS n FROM \`${db}\`.\`${tbl}\``,
          );
          const [tg] = (await target.unsafe(
            `SELECT count(*)::bigint AS n FROM "public"."${tbl}"`,
          )) as { n: string }[];
          if (String(s?.n) !== String(tg?.n)) {
            converged = false;
            log.info(`${t.name}: src=${s?.n} tgt=${tg?.n} (draining)`);
            break;
          }
        }
        if (converged) {
          log.ok("source/target row counts converged — CDC drained");
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            "row counts did not converge before deadline — are writes really stopped?",
          );
        }
        await this.io.sleep(2000);
      }

      // 2. identity/sequence resync (no-op for explicit-PK schemas with no owned sequences).
      await resyncTargetSequences(my, target, cfg);
    } finally {
      await my.end();
    }

    // 3. stop CDC (the analogue of dropping the subscription). teardown removes the container.
    const name = debeziumContainerName(cfg.replication.publication);
    await this.io.exec(debeziumStopArgv(name));
    log.ok(`stopped CDC (${name})`);
    log.warn(
      "Now: repoint your app to the target, verify, and DO NOT re-enable writes on the source.",
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

/** Introspect a target table's non-generated columns + their portable aggregate categories. */
async function targetAggColumns(target: Db, schema: string, table: string): Promise<AggColumn[]> {
  const rows = await target`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table} AND is_generated = 'NEVER'
    ORDER BY ordinal_position`;
  return rows.map((r) => ({
    name: String(r.column_name),
    category: categorizePgType(String(r.data_type)),
  }));
}

/** Read the MySQL binlog position as `file:pos`. Handles the 8.4 rename of SHOW MASTER STATUS. */
async function binlogPosition(my: MySqlConn): Promise<string> {
  for (const stmt of ["SHOW BINARY LOG STATUS", "SHOW MASTER STATUS"]) {
    try {
      const [r] = await my.query<{ File?: string; Position?: string | number }>(stmt);
      if (r?.File) return `${r.File}:${r.Position}`;
    } catch {
      /* try the other spelling */
    }
  }
  throw new Error(
    "could not read MySQL binlog position (SHOW BINARY LOG STATUS / SHOW MASTER STATUS) — " +
      "the CDC user needs REPLICATION CLIENT (MySQL ≤8.0) / BINLOG MONITOR (8.4+) grant.",
  );
}

/**
 * Resync target identity/serial sequences to the source's MAX(owning column). Debezium upserts
 * explicit PK values, so any target sequence is stuck at its schema-load value and the next LOCAL
 * insert would collide. No-op when the schema has no owned sequences (explicit-PK / uuid tables).
 */
async function resyncTargetSequences(my: MySqlConn, target: Db, cfg: Config): Promise<void> {
  for (const t of cfg.reconcile.tables) {
    const [db, tbl] = t.name.split(".") as [string, string];
    const seqs = await target`
      SELECT quote_ident(sn.nspname) || '.' || quote_ident(s.relname) AS seq, a.attname AS col
      FROM pg_class s
      JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      JOIN pg_class rt ON rt.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = rt.relnamespace
      JOIN pg_attribute a ON a.attrelid = rt.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S' AND tn.nspname = 'public' AND rt.relname = ${tbl}`;
    if (seqs.length === 0) {
      log.detail(`${t.name}: no owned target sequences — nothing to resync`);
      continue;
    }
    for (const row of seqs) {
      const seq = String(row.seq);
      const col = String(row.col);
      try {
        const [mx] = await my.query<{ m: string | null }>(
          `SELECT max(\`${col}\`) AS m FROM \`${db}\`.\`${tbl}\``,
        );
        const maxVal = mx?.m ?? null;
        if (maxVal === null) {
          log.detail(`${seq}: source MAX(${col}) is NULL — leaving sequence as-is`);
          continue;
        }
        await target.unsafe(`SELECT setval($1, $2, true)`, [seq, String(maxVal)]);
        log.ok(`sequence ${seq} set to ${maxVal} (from source MAX(${col}))`);
      } catch (e) {
        log.warn(
          `sequence ${seq} resync failed (${e instanceof Error ? e.message : String(e)}) — set it manually`,
        );
      }
    }
  }
}

/** Parse the Quarkus /q/health JSON: overall UP + the `debezium` connector check status. */
export function parseDebeziumHealth(body: string): { up: boolean; debeziumUp: boolean } {
  try {
    const j = JSON.parse(body) as {
      status?: string;
      checks?: { name?: string; status?: string }[];
    };
    const up = j.status === "UP";
    const check = Array.isArray(j.checks) ? j.checks.find((c) => c.name === "debezium") : undefined;
    // if there's no named debezium check, fall back to the overall status
    return { up, debeziumUp: check ? check.status === "UP" : up };
  } catch {
    return { up: false, debeziumUp: false };
  }
}
