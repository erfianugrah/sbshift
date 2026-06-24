import { log } from "../log.ts";
import type { ProviderHintItem } from "./schema.ts";

/** Default staleness threshold — mirrors the run-time soft-warn cadence in
 *  docs/GUIDED-MIGRATION.md §6 ("this step's knowledge is 90 days old"). */
export const DEFAULT_MAX_AGE_DAYS = 90;

const MS_PER_DAY = 86_400_000;

export interface DriftRow {
  id: string;
  /** provenance.source — where a human goes to re-verify the guidance. */
  source: string;
  lastSynced: string;
  /** Whole days between `lastSynced` (UTC midnight) and the reference `now`. */
  ageDays: number;
  stale: boolean;
}

export interface DriftReport {
  maxAgeDays: number;
  /** Reference date (YYYY-MM-DD) the ages were computed against. */
  now: string;
  /** Stalest first. */
  rows: DriftRow[];
  staleCount: number;
}

/** Parse a YYYY-MM-DD stamp as UTC midnight (the schema guarantees the format). */
function parseISODate(s: string): number {
  return Date.parse(`${s}T00:00:00Z`);
}

/**
 * The lastSynced-age drift check: pure, no network. Each item is "stale" when its guidance
 * hasn't been re-verified against `provenance.source` within `maxAgeDays`. Content-hashing
 * the cited section is a deliberate future layer — for now, age is the freshness signal
 * (docs/GUIDED-MIGRATION.md §6). Injectable `now` keeps it deterministic under test.
 */
export function kbDrift(
  items: readonly ProviderHintItem[],
  opts: { now?: Date; maxAgeDays?: number } = {},
): DriftReport {
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const rows: DriftRow[] = items
    .map((it) => {
      const ageDays = Math.floor((nowMs - parseISODate(it.provenance.lastSynced)) / MS_PER_DAY);
      return {
        id: it.id,
        source: it.provenance.source,
        lastSynced: it.provenance.lastSynced,
        ageDays,
        stale: ageDays >= maxAgeDays,
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays);
  return {
    maxAgeDays,
    now: now.toISOString().slice(0, 10),
    rows,
    staleCount: rows.filter((r) => r.stale).length,
  };
}

/** Human-readable render of a drift report via the structured logger. */
export function renderDrift(report: DriftReport): void {
  log.step(`kb drift: ${report.rows.length} items, threshold ${report.maxAgeDays}d`);
  for (const r of report.rows) {
    const line = `${r.id}  ${r.ageDays}d  ${r.source}`;
    if (r.stale) log.warn(`${line}  — STALE, re-verify against source`);
    else log.ok(line);
  }
  report.staleCount > 0
    ? log.err(
        `${report.staleCount} of ${report.rows.length} stale (threshold ${report.maxAgeDays}d)`,
      )
    : log.info(`all ${report.rows.length} items within ${report.maxAgeDays}d`);
}
