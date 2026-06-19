import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { withRetry } from "../db.ts";
import { log } from "../log.ts";

/**
 * Reconciliation at prod scale.
 *
 * A single `sum(hashtextextended(row::text))` over a large table is a fully
 * synchronized sequential scan on BOTH sides for as long as it takes — and when
 * it mismatches it tells you nothing about WHICH rows diverged.
 *
 * The chunked strategy (default) instead does ONE scan per side that buckets
 * rows by a hash of their primary key into N buckets, producing (count, hash)
 * per bucket. Buckets are compared cheaply; only mismatched buckets are
 * drilled into for row-level diff. This is resumable, bounded-memory, and
 * pinpoints the exact divergent / missing / extra rows.
 */

export type ReconcileMode = "chunked" | "full";

export type BucketRow = { b: number; n: bigint; h: string };
export type DrillExample = {
  pk: string;
  kind: "missing_on_target" | "extra_on_target" | "hash_diff";
};

/** Pure: which bucket indices differ in count or content hash. */
export function diffBuckets(
  sMap: Map<number, BucketRow>,
  tMap: Map<number, BucketRow>,
  buckets: number,
): number[] {
  const mismatched: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const s = sMap.get(b);
    const t = tMap.get(b);
    if ((s?.h ?? "0") !== (t?.h ?? "0") || (s?.n ?? 0n) !== (t?.n ?? 0n)) mismatched.push(b);
  }
  return mismatched;
}

/** Pure: classify per-row divergence within a drilled bucket (pk -> rowhash). */
export function classifyRows(
  sRows: Map<string, string>,
  tRows: Map<string, string>,
  maxExamples: number,
): DrillExample[] {
  const out: DrillExample[] = [];
  for (const [pk, h] of sRows) {
    if (out.length >= maxExamples) return out;
    if (!tRows.has(pk)) out.push({ pk, kind: "missing_on_target" });
    else if (tRows.get(pk) !== h) out.push({ pk, kind: "hash_diff" });
  }
  for (const pk of tRows.keys()) {
    if (out.length >= maxExamples) return out;
    if (!sRows.has(pk)) out.push({ pk, kind: "extra_on_target" });
  }
  return out;
}
type TableReport = {
  table: string;
  mode: ReconcileMode;
  buckets: number;
  sourceRows: number;
  targetRows: number;
  mismatchedBuckets: number[];
  examples: DrillExample[];
  match: boolean;
};

// L-11: both source and target scans are launched concurrently via Promise.all.
// This halves wall-clock time but doubles peak I/O on both machines simultaneously.
// For a large table that's acceptable; on IOPS-constrained instances consider
// serialising by removing the Promise.all and awaiting each scan separately.
const ONLY = (schema: string, table: string) => `ONLY "${schema}"."${table}"`;

async function pkColumns(db: Db, schema: string, table: string): Promise<string[]> {
  const rows = await db`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = ${`"${schema}"."${table}"`}::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`;
  return rows.map((r) => String(r.attname));
}

async function nonGeneratedColumns(db: Db, schema: string, table: string): Promise<string[]> {
  const rows = await db`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table} AND is_generated = 'NEVER'
    ORDER BY ordinal_position`;
  return rows.map((r) => String(r.column_name));
}

function rowExpr(cols: string[]): string {
  return `(${cols.map((c) => `"${c}"`).join(",")})::text`;
}

export async function reconcile(
  source: Db,
  target: Db,
  cfg: Config,
  opts: { mode?: ReconcileMode; buckets?: number; maxExamples?: number; outDir?: string } = {},
): Promise<boolean> {
  const mode: ReconcileMode = opts.mode ?? "chunked";
  const buckets = opts.buckets ?? 256;
  const maxExamples = opts.maxExamples ?? 20;
  const outDir = opts.outDir ?? "ledger";
  log.step(`reconcile (${mode}${mode === "chunked" ? `, ${buckets} buckets` : ""})`);

  // Pre-flight: reconcile is only meaningful once the target has caught up. If the
  // replication slot still exists AND retains WAL the subscriber hasn't confirmed,
  // the source has in-flight rows not yet on the target — reconcile will report
  // spurious `missing_on_target` diffs. Warn loudly; this is a correctness footgun,
  // not a hard error (you may be reconciling mid-stream deliberately).
  try {
    const [lagRow] = await source`
      SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes, active
      FROM pg_replication_slots WHERE slot_name = ${cfg.replication.slot}`;
    if (lagRow) {
      const lagKb = Number(lagRow.lag_bytes ?? 0) / 1024;
      if (lagKb > 0) {
        log.warn(
          `replication slot ${cfg.replication.slot} still retains ${lagKb.toFixed(1)} KB of ` +
            "un-confirmed WAL — the source has rows not yet on the target. Expect FALSE " +
            "`missing_on_target` diffs. Run reconcile only AFTER cutover drains lag to zero.",
        );
      }
    }
  } catch {
    /* slot already torn down (post-teardown reconcile) — nothing to check */
  }

  const reports: TableReport[] = [];
  for (const t of cfg.reconcile.tables) {
    const [schema, table] = t.name.split(".") as [string, string];
    const cols = t.hashColumns ?? (await nonGeneratedColumns(source, schema, table));
    if (cols.length === 0) {
      log.err(`${t.name}: no non-generated columns`);
      return false;
    }
    const report =
      mode === "full"
        ? await reconcileFull(source, target, schema, table, cols)
        : await reconcileChunked(source, target, schema, table, cols, buckets, maxExamples);
    reports.push(report);

    const head = `${t.name}: src=${report.sourceRows} tgt=${report.targetRows}`;
    if (report.match) {
      log.ok(head);
    } else {
      log.err(`${head} | mismatched buckets: ${report.mismatchedBuckets.length}`);
      for (const ex of report.examples) log.detail(`${ex.kind}: ${ex.pk}`);
    }
  }

  // optional rehearsal-only inflight-loss proof
  let ledgerOk = true;
  if (cfg.reconcile.ledgerPath && cfg.reconcile.ledgerTable) {
    ledgerOk = await reconcileLedger(target, cfg);
  }

  mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/reconcile-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ reports, ledgerOk }, null, 2));
  log.detail(`report written to ${outPath}`);

  const allMatch = reports.every((r) => r.match) && ledgerOk;
  allMatch
    ? log.ok("RECONCILE PASSED — source and target are identical")
    : log.err("RECONCILE FAILED — see mismatched buckets / examples above");
  return allMatch;
}

async function reconcileFull(
  source: Db,
  target: Db,
  schema: string,
  table: string,
  cols: string[],
): Promise<TableReport> {
  const q = `SELECT count(*)::bigint AS n,
                    coalesce(sum(hashtextextended(${rowExpr(cols)}, 0)), 0)::text AS h
             FROM ${ONLY(schema, table)}`;
  const [s] = await withRetry(() => source.unsafe(q), `reconcile/full ${schema}.${table} source`);
  const [tg] = await withRetry(() => target.unsafe(q), `reconcile/full ${schema}.${table} target`);
  return {
    table: `${schema}.${table}`,
    mode: "full",
    buckets: 1,
    sourceRows: Number(s?.n ?? -1),
    targetRows: Number(tg?.n ?? -2),
    mismatchedBuckets: s?.h === tg?.h ? [] : [0],
    examples: [],
    match: s?.n === tg?.n && s?.h === tg?.h,
  };
}

async function reconcileChunked(
  source: Db,
  target: Db,
  schema: string,
  table: string,
  cols: string[],
  buckets: number,
  maxExamples: number,
): Promise<TableReport> {
  const pk = await pkColumns(source, schema, table);
  const keyCols = pk.length > 0 ? pk : cols;
  const bucketExpr = `(abs(hashtextextended(${rowExpr(keyCols)}, 0)) % ${buckets})`;
  const aggQ = `SELECT ${bucketExpr} AS b, count(*)::bigint AS n,
                       coalesce(sum(hashtextextended(${rowExpr(cols)}, 0)), 0)::text AS h
                FROM ${ONLY(schema, table)} GROUP BY 1`;

  const [srcAgg, tgtAgg] = await Promise.all([
    withRetry(() => source.unsafe(aggQ), `reconcile/agg ${schema}.${table} source`),
    withRetry(() => target.unsafe(aggQ), `reconcile/agg ${schema}.${table} target`),
  ]);
  const sMap = new Map<number, BucketRow>(
    srcAgg.map((r) => [Number(r.b), { b: Number(r.b), n: BigInt(r.n), h: String(r.h) }]),
  );
  const tMap = new Map<number, BucketRow>(
    tgtAgg.map((r) => [Number(r.b), { b: Number(r.b), n: BigInt(r.n), h: String(r.h) }]),
  );

  const mismatched = diffBuckets(sMap, tMap, buckets);

  const sourceRows = [...sMap.values()].reduce((a, r) => a + Number(r.n), 0);
  const targetRows = [...tMap.values()].reduce((a, r) => a + Number(r.n), 0);

  // Drill only the mismatched buckets for row-level examples.
  const examples: DrillExample[] = [];
  for (const b of mismatched) {
    if (examples.length >= maxExamples) break;
    const drillQ = `SELECT ${rowExpr(keyCols)} AS pk, hashtextextended(${rowExpr(cols)}, 0)::text AS h
                    FROM ${ONLY(schema, table)} WHERE ${bucketExpr} = ${b}`;
    const [sr, tr] = await Promise.all([
      withRetry(() => source.unsafe(drillQ), `reconcile/drill ${schema}.${table} b=${b} source`),
      withRetry(() => target.unsafe(drillQ), `reconcile/drill ${schema}.${table} b=${b} target`),
    ]);
    const sRows = new Map(sr.map((r) => [String(r.pk), String(r.h)]));
    const tRows = new Map(tr.map((r) => [String(r.pk), String(r.h)]));
    examples.push(...classifyRows(sRows, tRows, maxExamples - examples.length));
  }

  return {
    table: `${schema}.${table}`,
    mode: "chunked",
    buckets,
    sourceRows,
    targetRows,
    mismatchedBuckets: mismatched,
    examples,
    match: mismatched.length === 0,
  };
}

/** Exported for testing. Verifies every id written to the ledger file is present on the target. */
export async function reconcileLedger(target: Db, cfg: Config): Promise<boolean> {
  const path = cfg.reconcile.ledgerPath as string;
  const [schema, table] = (cfg.reconcile.ledgerTable as string).split(".") as [string, string];
  const idCol = cfg.reconcile.ledgerIdColumn;
  const ids = readFileSync(path, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    log.warn("ledger empty — skipping inflight-loss check");
    return true;
  }
  // Batch the membership check so a multi-million-row ledger doesn't build one giant array param.
  const BATCH = 10_000;
  let missing = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const [r] = await target.unsafe(
      `WITH ledger(id) AS (SELECT unnest($1::text[]))
       SELECT count(*)::bigint AS n
       FROM ledger l LEFT JOIN "${schema}"."${table}" t ON t."${idCol}"::text = l.id
       WHERE t."${idCol}" IS NULL`,
      [slice],
    );
    missing += Number(r?.n ?? 0);
  }
  if (missing === 0) {
    log.ok(`ledger: all ${ids.length} written ids present on target (no inflight loss)`);
    return true;
  }
  log.err(`ledger: ${missing} of ${ids.length} written ids MISSING on target`);
  return false;
}
