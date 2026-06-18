import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

type TableResult = {
  table: string;
  sourceCount: number;
  targetCount: number;
  sourceHash: string;
  targetHash: string;
  match: boolean;
};

/**
 * Prove source and target are identical AFTER writes are stopped and lag drains.
 *  - row count per table
 *  - order-independent content hash over an EXPLICIT column list that EXCLUDES
 *    generated columns (the subscriber recomputes those; hashing them risks
 *    false mismatches from text-search-config differences).
 *  - optional: every id in the rehearsal writer's ledger exists on the target.
 *
 * Returns true iff everything matches.
 */
export async function reconcile(source: Db, target: Db, cfg: Config): Promise<boolean> {
  log.step("reconcile");
  const results: TableResult[] = [];

  for (const t of cfg.reconcile.tables) {
    const [schema, table] = t.name.split(".") as [string, string];
    const cols = t.hashColumns ?? (await autoColumns(source, schema, table));
    if (cols.length === 0) {
      log.err(`${t.name}: no non-generated columns resolved`);
      return false;
    }
    const rowExpr = `(${cols.map((c) => `"${c}"`).join(",")})::text`;
    // hashtextextended over a ROW cast; sum is order-independent.
    const q = `SELECT count(*)::bigint AS n,
                      coalesce(sum(hashtextextended(${rowExpr}, 0)), 0)::text AS h
               FROM ONLY "${schema}"."${table}"`;
    const [s] = await source.unsafe(q);
    const [tg] = await target.unsafe(q);
    const r: TableResult = {
      table: t.name,
      sourceCount: Number(s?.n ?? -1),
      targetCount: Number(tg?.n ?? -2),
      sourceHash: String(s?.h ?? ""),
      targetHash: String(tg?.h ?? ""),
      match: s?.n === tg?.n && s?.h === tg?.h,
    };
    results.push(r);
    const line = `${r.table}: count ${r.sourceCount}=${r.targetCount} hash ${r.sourceHash}=${r.targetHash}`;
    r.match ? log.ok(line) : log.err(line);
  }

  let ledgerOk = true;
  if (cfg.reconcile.ledgerPath && cfg.reconcile.ledgerTable) {
    ledgerOk = await reconcileLedger(target, cfg);
  }

  const allMatch = results.every((r) => r.match) && ledgerOk;
  allMatch
    ? log.ok("RECONCILE PASSED — source and target are identical")
    : log.err("RECONCILE FAILED — see mismatches above");
  return allMatch;
}

async function autoColumns(db: Db, schema: string, table: string): Promise<string[]> {
  const rows = await db`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}
      AND is_generated = 'NEVER'
    ORDER BY ordinal_position`;
  return rows.map((r) => String(r.column_name));
}

async function reconcileLedger(target: Db, cfg: Config): Promise<boolean> {
  const path = cfg.reconcile.ledgerPath as string;
  const [schema, table] = (cfg.reconcile.ledgerTable as string).split(".") as [string, string];
  const idCol = cfg.reconcile.ledgerIdColumn;
  const ids = readFileSync(path, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    log.warn("ledger is empty — skipping inflight-loss check");
    return true;
  }
  // Build a VALUES list of ids and left-join against the target table.
  const missing = await target.unsafe(
    `WITH ledger(id) AS (SELECT unnest($1::text[]))
     SELECT count(*)::bigint AS n
     FROM ledger l LEFT JOIN "${schema}"."${table}" t ON t."${idCol}"::text = l.id
     WHERE t."${idCol}" IS NULL`,
    [ids],
  );
  const n = Number(missing[0]?.n ?? -1);
  if (n === 0) {
    log.ok(`ledger: all ${ids.length} written ids present on target (no inflight loss)`);
    return true;
  }
  log.err(
    `ledger: ${n} of ${ids.length} written ids MISSING on target — inflight writes were lost`,
  );
  return false;
}
