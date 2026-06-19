import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { reconcile } from "../steps/reconcile.ts";
import { run } from "../steps/run.ts";
import { teardown } from "../steps/teardown.ts";
import { runChaos, type ScenarioName } from "./chaos.ts";
import { seedToSize } from "./seed.ts";

/**
 * End-to-end scale rehearsal, in TypeScript (not a hand-chained bash script):
 *
 *   seed-to-size → run(preflight→replicate→watch→reconcile) →
 *   [inject a fault → reconcile MUST fail] → teardown
 *
 * Runs against a THROWAWAY pair only (it seeds `public.documents`). The fault gate
 * proves reconcile still catches divergence at the rehearsal's scale, not just
 * in the unit/integration fixtures.
 */
export interface RehearseOptions {
  targetBytes: number;
  payloadBytes: number;
  batchRows: number;
  concurrency: number;
  /** Optional fault to inject after a clean sync; reconcile must then FAIL. */
  chaos?: ScenarioName;
  chaosArg?: string;
}

export async function rehearseRun(
  source: Db,
  target: Db,
  cfg: Config,
  secrets: Secrets,
  opts: RehearseOptions,
): Promise<boolean> {
  await seedToSize(source, {
    targetBytes: opts.targetBytes,
    payloadBytes: opts.payloadBytes,
    batchRows: opts.batchRows,
    concurrency: opts.concurrency,
  });

  // H-3: always teardown, even on early failure — the previous code returned false
  // before teardown, leaving a stale slot/publication/subscription behind.
  let pipelineOk = false;
  let gateOk = true;
  try {
    const r = await run(source, target, cfg, secrets, { through: "reconcile" });
    if (!r.ok) {
      log.err("rehearsal: migration pipeline failed before the fault gate");
      return false;
    }
    pipelineOk = true;

    if (opts.chaos) {
      log.step(`rehearsal fault gate: ${opts.chaos}`);
      await runChaos({ source, target, arg: opts.chaosArg }, opts.chaos);
      const stillMatches = await reconcile(source, target, cfg);
      if (stillMatches) {
        log.err(`fault gate MISSED — reconcile passed after '${opts.chaos}' (should have failed)`);
        gateOk = false;
      } else {
        log.ok(`fault gate OK — reconcile correctly caught '${opts.chaos}'`);
      }
    }
  } finally {
    await teardown(source, target, cfg);
  }

  const ok = pipelineOk && gateOk;
  ok ? log.ok("rehearsal complete") : log.err("rehearsal complete with gate failure");
  return ok;
}
