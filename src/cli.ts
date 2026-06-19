#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { type Config, loadConfig, loadSecrets } from "./config.ts";
import { connect, type Db } from "./db.ts";
import { log } from "./log.ts";
import { MgmtApi } from "./mgmt.ts";
import { runChaos, SCENARIOS, type ScenarioName } from "./rehearsal/chaos.ts";
import { rehearseRun } from "./rehearsal/orchestrate.ts";
import { seed, seedToSize } from "./rehearsal/seed.ts";
import { writer } from "./rehearsal/writer.ts";
import { transferFunctions, transferStorage } from "./steps/cli-wrappers.ts";
import { configSync } from "./steps/config-sync.ts";
import { cutover } from "./steps/cutover.ts";
import { doctor } from "./steps/doctor.ts";
import { preflight } from "./steps/preflight.ts";
import { reconcile } from "./steps/reconcile.ts";
import { replicate } from "./steps/replicate.ts";
import { PHASES, type Phase, run } from "./steps/run.ts";
import { printStatus, status } from "./steps/status.ts";
import { teardown } from "./steps/teardown.ts";
import { watch } from "./steps/watch.ts";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command();
program
  .name("sbmigrate")
  .version(version, "-V, --version")
  .description(
    "Cross-region Supabase migration orchestrator (logical replication).\n" +
      "Step-by-step runbook: docs/RUNBOOK.md. Start with `sbmigrate doctor`.",
  )
  .option("-c, --config <path>", "path to migrate.config.yaml", "migrate.config.yaml");

/** Run a step that needs DB connections, ensuring clients are always closed. */
async function withDb(
  fn: (db: { source: Db; target: Db }, cfg: Config) => Promise<void>,
): Promise<void> {
  const cfg = loadConfig(program.opts().config);
  const secrets = loadSecrets();
  const { source, target, close } = connect(secrets);
  try {
    await fn({ source, target }, cfg);
  } catch (e) {
    log.err(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await close();
  }
}

program
  .command("run")
  .description(
    "autonomously run the pipeline (preflight→replicate→watch→reconcile) — for CI/Lambda",
  )
  .option("--through <phase>", `stop after: ${PHASES.join(" | ")}`, "reconcile")
  .option("--json", "emit NDJSON events on stdout (human logs → stderr)", false)
  .option("--confirm-writes-stopped", "required to allow --through cutover", false)
  .option("--max-lag-wait <sec>", "cutover lag-drain wait", "300")
  .action((o) => {
    const through = o.through as Phase;
    if (!PHASES.includes(through)) {
      log.err(`unknown --through '${through}' (valid: ${PHASES.join(", ")})`);
      process.exitCode = 1;
      return;
    }
    if (o.json) log.toStderr();
    return withDb(async ({ source, target }, cfg) => {
      const r = await run(source, target, cfg, loadSecrets(), {
        through,
        json: Boolean(o.json),
        confirmWritesStopped: Boolean(o.confirmWritesStopped),
        maxLagWaitSec: Number(o.maxLagWait),
      });
      if (!r.ok) process.exitCode = 1;
    });
  });

program
  .command("status")
  .description("poll-once replication snapshot (sync state, WAL, lag) — for a scheduled watcher")
  .option("--json", "emit a single JSON object on stdout", false)
  .option("--require-synced", "exit non-zero unless all tables are ready", false)
  .action((o) => {
    if (o.json) log.toStderr();
    return withDb(async ({ source, target }, cfg) => {
      const snap = await status(source, target, cfg);
      if (o.json) process.stdout.write(`${JSON.stringify(snap)}\n`);
      else printStatus(snap);
      if (o.requireSynced && !snap.tables.allReady) process.exitCode = 1;
    });
  });

program
  .command("doctor")
  .description("automated readiness checklist (config, connectivity, schema, reconcile, target)")
  .option("--source-only", "skip target probing (target not created yet)", false)
  .action((o) => {
    const cfg = loadConfig(program.opts().config);
    const secrets = loadSecrets();
    doctor(cfg, secrets, { sourceOnly: Boolean(o.sourceOnly) })
      .then((r) => {
        if (r.fail > 0) process.exitCode = 1;
      })
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

program
  .command("preflight")
  .description("read-only checks: versions, wal_level, subscribe grant, replica identity")
  .action(() => withDb(({ source, target }, cfg) => preflight(source, target, cfg)));

program
  .command("replicate")
  .description("create publication + slot + subscription (starts initial sync)")
  .action(() => withDb(({ source, target }, cfg) => replicate(source, target, cfg, loadSecrets())));

program
  .command("watch")
  .description("poll initial-sync state + WAL bloat watchdog until all tables ready")
  .action(() => withDb(({ source, target }, cfg) => watch(source, target, cfg)));

program
  .command("reconcile")
  .description("chunked checksum reconciliation (run after writes stop & lag drains)")
  .option("--mode <mode>", "chunked | full", "chunked")
  .option("--buckets <n>", "bucket count for chunked mode", "256")
  .option("--max-examples <n>", "max divergent rows to report", "20")
  .action((o) =>
    withDb(async ({ source, target }, cfg) => {
      const ok = await reconcile(source, target, cfg, {
        mode: o.mode === "full" ? "full" : "chunked",
        buckets: Number(o.buckets),
        maxExamples: Number(o.maxExamples),
      });
      if (!ok) process.exitCode = 1;
    }),
  );

program
  .command("cutover")
  .description("drain lag to zero then drop the subscription (stop app writes FIRST)")
  .option("--max-lag-wait <sec>", "seconds to wait for lag to drain", "300")
  .action((o) =>
    withDb(({ source, target }, cfg) =>
      cutover(source, target, cfg, { maxLagWaitSec: Number(o.maxLagWait) }),
    ),
  );

program
  .command("teardown")
  .description("drop subscription/slot/publication safely (idempotent)")
  .action(() => withDb(({ source, target }, cfg) => teardown(source, target, cfg)));

program
  .command("config-sync")
  .description("copy Auth/Realtime/Storage/etc config via Management API (secrets stripped)")
  .option("--dry-run", "diff only, do not apply", false)
  .action((o) => {
    const cfg = loadConfig(program.opts().config);
    const secrets = loadSecrets(true);
    const api = new MgmtApi(secrets.SUPABASE_ACCESS_TOKEN as string);
    api
      .assertAccess([cfg.source.ref, cfg.target.ref])
      .then(() => configSync(api, cfg, { dryRun: Boolean(o.dryRun) }))
      .catch((e) => {
        log.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      });
  });

program
  .command("functions")
  .description("transfer Edge Functions via the supabase CLI")
  .option("--dry-run", "print commands only", false)
  .action((o) =>
    transferFunctions(loadConfig(program.opts().config), { dryRun: Boolean(o.dryRun) }),
  );

program
  .command("storage <localDir>")
  .description("push downloaded storage objects to target buckets via the supabase CLI")
  .option("--dry-run", "print commands only", false)
  .action((dir, o) =>
    transferStorage(loadConfig(program.opts().config), dir, { dryRun: Boolean(o.dryRun) }),
  );

// --- rehearsal harness ---
const rehearse = program.command("rehearse").description("rehearsal data harness (test rig)");

rehearse
  .command("seed")
  .description("seed the source documents table")
  .option("--rows <n>", "row count", "100000")
  .option("--payload <bytes>", "approx payload bytes per row", "6000")
  .action((o) => withDb(({ source }, _cfg) => seed(source, Number(o.rows), Number(o.payload))));

rehearse
  .command("seed-size")
  .description("seed to a target ON-DISK SIZE to emulate prod scale (e.g. --gib 200)")
  .option("--gib <n>", "target table size in GiB", "10")
  .option("--payload <bytes>", "approx payload bytes per row", "6000")
  .option("--batch <rows>", "rows per insert batch", "50000")
  .option("--concurrency <n>", "parallel insert batches", "4")
  .action((o) =>
    withDb(({ source }, _cfg) =>
      seedToSize(source, {
        targetBytes: Number(o.gib) * 1_073_741_824,
        payloadBytes: Number(o.payload),
        batchRows: Number(o.batch),
        concurrency: Number(o.concurrency),
      }),
    ),
  );

rehearse
  .command("run")
  .description("full scale rehearsal in-tool: seed → run → fault gate → teardown (THROWAWAY pair)")
  .option("--gib <n>", "target source size in GiB", "10")
  .option("--payload <bytes>", "approx payload bytes per row", "6000")
  .option("--batch <rows>", "rows per insert batch", "1000")
  .option("--concurrency <n>", "parallel insert batches", "4")
  .option(
    "--chaos <scenario>",
    `inject a fault after sync, expect reconcile to catch it: ${Object.keys(SCENARIOS).join(" | ")}`,
  )
  .option("--chaos-arg <value>", "argument for the chaos scenario (e.g. public.documents)")
  .action((o) => {
    if (o.chaos && !(o.chaos in SCENARIOS)) {
      log.err(`unknown --chaos '${o.chaos}' (valid: ${Object.keys(SCENARIOS).join(", ")})`);
      process.exitCode = 1;
      return;
    }
    return withDb(async ({ source, target }, cfg) => {
      const ok = await rehearseRun(source, target, cfg, loadSecrets(), {
        targetBytes: Number(o.gib) * 1_073_741_824,
        payloadBytes: Number(o.payload),
        batchRows: Number(o.batch),
        concurrency: Number(o.concurrency),
        chaos: o.chaos as ScenarioName | undefined,
        chaosArg: o.chaosArg,
      });
      if (!ok) process.exitCode = 1;
    });
  });

rehearse
  .command("chaos <scenario>")
  .description(`inject a failure mode: ${Object.keys(SCENARIOS).join(" | ")}`)
  .option("--arg <value>", "scenario argument (table / subscription name)")
  .action((scenario, o) => {
    if (!(scenario in SCENARIOS)) {
      log.err(`unknown scenario '${scenario}'. options: ${Object.keys(SCENARIOS).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    return withDb(({ source, target }, _cfg) =>
      runChaos({ source, target, arg: o.arg }, scenario as ScenarioName),
    );
  });

rehearse
  .command("writer")
  .description("continuous insert/update load with an append-only id ledger")
  .option("--ledger <path>", "ledger file path", "ledger/written_ids.log")
  .option("--interval <ms>", "ms between inserts", "50")
  .option("--duration <sec>", "stop after N seconds (default: run until Ctrl-C)")
  .action((o) =>
    withDb(({ source }, _cfg) =>
      writer(source, {
        ledgerPath: o.ledger,
        intervalMs: Number(o.interval),
        durationSec: o.duration ? Number(o.duration) : undefined,
      }),
    ),
  );

program.parseAsync();
