import { type Config, supabaseSourceRef } from "../config.ts";
import { log } from "../log.ts";

/**
 * Thin wrappers over the official `supabase` CLI. We do NOT reimplement these —
 * the CLI is authoritative for functions + storage object transfer.
 */

async function run(cmd: string[], opts: { dryRun: boolean }): Promise<void> {
  log.detail(`$ ${cmd.join(" ")}`);
  if (opts.dryRun) return;
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`command failed (exit ${code}): ${cmd.join(" ")}`);
}

/** Download Edge Functions from source, deploy to target. Requires `supabase login` done. */
export async function transferFunctions(cfg: Config, opts: { dryRun: boolean }): Promise<void> {
  log.step("edge functions");
  if (!cfg.functions.enabled) {
    log.detail("functions.enabled=false — skipping");
    return;
  }
  await run(["supabase", "functions", "download", "--project-ref", supabaseSourceRef(cfg)], opts);
  await run(["supabase", "functions", "deploy", "--project-ref", cfg.target.ref], opts);
  log.ok("functions deployed to target (re-set their secrets manually)");
}

/**
 * Copy storage objects. Assumes you have downloaded source objects locally to
 * `localDir`; pushes each bucket to the target via `supabase storage cp`.
 */
export async function transferStorage(
  cfg: Config,
  localDir: string,
  opts: { dryRun: boolean },
): Promise<void> {
  log.step("storage objects");
  if (cfg.storage.buckets.length === 0) {
    log.detail("no buckets configured — skipping");
    return;
  }
  await run(["supabase", "link", "--project-ref", cfg.target.ref], opts);
  for (const bucket of cfg.storage.buckets) {
    await run(
      [
        "supabase",
        "storage",
        "cp",
        `${localDir}/${bucket}`,
        `ss:///${bucket}`,
        "-r",
        "--experimental",
      ],
      opts,
    );
    log.ok(`copied bucket ${bucket}`);
  }
}
