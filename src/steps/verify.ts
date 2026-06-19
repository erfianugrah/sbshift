import { mkdirSync, writeFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { Lint, MgmtApi } from "../mgmt.ts";

/**
 * Post-migration health gate. Runs Supabase's advisor lints against the TARGET
 * project (the freshly migrated one) and fails if any lint is at/above the
 * configured severity. This is the cheap automated answer to "did logical
 * replication + the schema dump silently regress anything?" — the classic
 * footgun being RLS that did not come across (data copied, policies missing →
 * a wide-open `public` schema).
 *
 * It is deliberately NOT part of `config-sync`: config-sync mutates the target,
 * `verify` only reads + asserts, and you run it AFTER cutover.
 */

const LEVEL_RANK: Record<Lint["level"], number> = { INFO: 0, WARN: 1, ERROR: 2 };
export type FailOn = "error" | "warn" | "info";
const FAIL_RANK: Record<FailOn, number> = { info: 0, warn: 1, error: 2 };

export interface LintSummary {
  total: number;
  byLevel: Record<Lint["level"], number>;
  /** Count of lints at/above the fail-on threshold (drives the exit code). */
  gating: number;
}

/** Stable identity for a lint so security+performance overlap dedupes. */
function lintKey(l: Lint): string {
  const where = `${l.metadata?.schema ?? ""}.${l.metadata?.name ?? l.metadata?.entity ?? ""}`;
  return `${l.name}:${where}`;
}

/**
 * Pure: dedupe by name+entity, count by level, count gating lints.
 * Exported for unit testing — the gate verdict must be deterministic.
 */
export function summarizeLints(lints: Lint[], failOn: FailOn): LintSummary {
  const seen = new Set<string>();
  const byLevel: Record<Lint["level"], number> = { ERROR: 0, WARN: 0, INFO: 0 };
  let gating = 0;
  for (const l of lints) {
    const key = lintKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    byLevel[l.level]++;
    if (LEVEL_RANK[l.level] >= FAIL_RANK[failOn]) gating++;
  }
  return { total: seen.size, byLevel, gating };
}

/** Dedupe + sort ERROR-first for human display. Exported for tests. */
export function dedupeSortLints(lints: Lint[]): Lint[] {
  const seen = new Set<string>();
  const out: Lint[] = [];
  for (const l of [...lints].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])) {
    const key = lintKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

export interface VerifyResult {
  ok: boolean;
  summary: LintSummary;
  reportPath: string;
}

export async function verify(
  api: MgmtApi,
  cfg: Config,
  opts: { failOn: FailOn; outDir: string; json: boolean },
): Promise<VerifyResult> {
  const ref = cfg.target.ref;
  log.step(`verify ${ref} (post-migration advisors, fail-on=${opts.failOn})`);

  const [sec, perf] = await Promise.all([
    api.getAdvisors(ref, "security"),
    api.getAdvisors(ref, "performance"),
  ]);

  // Fail CLOSED: if BOTH advisor endpoints are unreachable we cannot assert
  // anything, so we must NOT report a green. (The endpoints are flagged
  // experimental/deprecated — see MgmtApi.getAdvisors.) A single-endpoint
  // failure still lets the other one gate.
  if (!sec.ok && !perf.ok) {
    log.err(
      `verify could not run — both advisor endpoints failed ` +
        `(security HTTP ${sec.status}, performance HTTP ${perf.status}). ` +
        `These endpoints are experimental/deprecated; if removed, switch verify to the SQL-lint path.`,
    );
    return {
      ok: false,
      summary: { total: 0, byLevel: { ERROR: 0, WARN: 0, INFO: 0 }, gating: 0 },
      reportPath: "",
    };
  }
  if (!sec.ok) log.warn("security advisors unavailable — gating on performance lints only");
  if (!perf.ok) log.warn("performance advisors unavailable — gating on security lints only");

  const all = [...sec.lints, ...perf.lints];
  const lints = dedupeSortLints(all);
  const summary = summarizeLints(all, opts.failOn);

  for (const level of ["ERROR", "WARN", "INFO"] as const) {
    const group = lints.filter((l) => l.level === level);
    if (group.length === 0) continue;
    log.info(`--- ${level} (${group.length}) ---`);
    for (const l of group) {
      const where =
        l.metadata?.schema || l.metadata?.name || l.metadata?.entity
          ? ` [${l.metadata?.schema ?? ""}.${l.metadata?.name ?? l.metadata?.entity ?? "?"}]`
          : "";
      const head = `${l.name}${where}: ${l.title}`;
      if (level === "ERROR") log.err(head);
      else if (level === "WARN") log.warn(head);
      else log.detail(head);
      if (l.remediation) log.detail(`  → ${l.remediation}`);
    }
  }

  mkdirSync(opts.outDir, { recursive: true });
  const reportPath = `${opts.outDir}/verify-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify({ ref, failOn: opts.failOn, summary, lints }, null, 2));

  const ok = summary.gating === 0;
  const tally = `${summary.byLevel.ERROR} error / ${summary.byLevel.WARN} warn / ${summary.byLevel.INFO} info`;
  if (ok) {
    log.ok(`verify passed — ${tally} (none at/above '${opts.failOn}'). Report: ${reportPath}`);
  } else {
    log.err(
      `verify FAILED — ${summary.gating} lint(s) at/above '${opts.failOn}' (${tally}). Report: ${reportPath}`,
    );
  }

  if (opts.json) process.stdout.write(`${JSON.stringify({ ok, ref, summary, reportPath })}\n`);
  return { ok, summary, reportPath };
}
