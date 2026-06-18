import type { Config, Secrets } from "../config.ts";
import { classifyConn, connect, type Db } from "../db.ts";
import { log } from "../log.ts";

/**
 * `doctor` — an automated, re-runnable readiness checklist.
 *
 * Everything you'd otherwise check by hand with psql before a migration:
 * connection shape (pooler vs direct), reachability, source wal_level + replica
 * identity, the reconcile hashColumns ↔ live-schema cross-check, stale
 * publication/slot leftovers, row counts, and (when the target exists) its PG
 * version + CREATE SUBSCRIPTION grant + whether the schema is loaded yet.
 *
 * Tolerant by design: the target usually does NOT exist during prep, so an
 * unreachable target is reported, not fatal. Source schema checks are skipped
 * (not failed) when the source can't be reached.
 */

export interface HashColumnDiff {
  /** live non-generated columns NOT in the pinned list → silently un-hashed (divergence missed). */
  missingFromPinned: string[];
  /** pinned columns that don't exist on the table → reconcile SQL would error. */
  nonexistent: string[];
  /** pinned columns that are generated → recomputed on subscriber → false mismatch. */
  generatedPinned: string[];
}

/** Pure: compare a reconcile table's pinned hashColumns against the live schema. */
export function diffHashColumns(
  pinned: string[] | undefined,
  liveNonGenerated: string[],
  liveGenerated: string[],
): HashColumnDiff {
  if (!pinned) return { missingFromPinned: [], nonexistent: [], generatedPinned: [] };
  const all = new Set([...liveNonGenerated, ...liveGenerated]);
  const gen = new Set(liveGenerated);
  const pinnedSet = new Set(pinned);
  return {
    missingFromPinned: liveNonGenerated.filter((c) => !pinnedSet.has(c)),
    nonexistent: pinned.filter((c) => !all.has(c)),
    generatedPinned: pinned.filter((c) => gen.has(c)),
  };
}

export interface DoctorReport {
  pass: number;
  warn: number;
  fail: number;
}

export async function doctor(
  cfg: Config,
  secrets: Secrets,
  opts: { sourceOnly?: boolean } = {},
): Promise<DoctorReport> {
  const r: DoctorReport = { pass: 0, warn: 0, fail: 0 };
  const ok = (m: string) => {
    r.pass++;
    log.ok(m);
  };
  const warn = (m: string) => {
    r.warn++;
    log.warn(m);
  };
  const fail = (m: string) => {
    r.fail++;
    log.err(m);
  };

  // ── 1. config + secrets (no network) ───────────────────────────────────
  log.step("doctor: config + connection shape");
  log.detail(`source ref ${cfg.source.ref}  →  target ref ${cfg.target.ref}`);
  secrets.SUPABASE_ACCESS_TOKEN
    ? ok("SUPABASE_ACCESS_TOKEN present (config-sync available)")
    : warn("SUPABASE_ACCESS_TOKEN unset — config-sync will be unavailable");

  const src = classifyConn(secrets.SOURCE_DB_URL);
  const tgt = classifyConn(secrets.TARGET_DB_URL);
  log.detail(`source conn ${src.host}:${src.port}   target conn ${tgt.host}:${tgt.port}`);
  if (src.isPooler)
    warn(
      "SOURCE_DB_URL is a POOLER endpoint — fine for these read-only checks, but the replication " +
        "subscription's CONNECTION must be the DIRECT host (db.<ref>.supabase.co); the pooler can't stream WAL.",
    );
  else if (src.isSupabaseDirect)
    ok(`SOURCE_DB_URL is the direct host (ref ${src.ref}) — correct for replication`);
  if (!opts.sourceOnly) {
    if (tgt.isPooler)
      warn("TARGET_DB_URL is a POOLER endpoint — CREATE SUBSCRIPTION needs the direct host");
    else if (tgt.isSupabaseDirect)
      ok(`TARGET_DB_URL is the direct host (ref ${tgt.ref}) — correct for replication`);
  }

  // ── 2. connect (short timeout, tolerant) ───────────────────────────────
  const { source, target, close } = connect(secrets, { connectTimeoutSec: 10 });
  try {
    const srcReach = await probe(source);
    if (srcReach.ok) ok(`source reachable (${src.host})`);
    else {
      fail(`source UNREACHABLE (${src.host}): ${reachHint(srcReach.error, src)}`);
    }

    // ── 3. source schema checks ──────────────────────────────────────────
    if (srcReach.ok) await sourceChecks(source, cfg, { ok, warn, fail });

    // ── 4. target checks ─────────────────────────────────────────────────
    if (!opts.sourceOnly) {
      const tgtReach = await probe(target);
      if (tgtReach.ok) {
        ok(`target reachable (${tgt.host})`);
        await targetChecks(source, target, cfg, srcReach.ok, { ok, warn, fail });
      } else {
        warn(
          `target not reachable yet (${tgt.host}) — expected during prep before it's created: ${reachHint(tgtReach.error, tgt)}`,
        );
      }
    }
  } finally {
    await close();
  }

  // ── summary ──────────────────────────────────────────────────────────
  log.step("doctor: summary");
  const verdict = r.fail > 0 ? "NOT READY" : r.warn > 0 ? "READY (with warnings)" : "READY";
  log.detail(`${r.pass} pass · ${r.warn} warn · ${r.fail} fail`);
  r.fail > 0 ? log.err(verdict) : log.ok(verdict);
  return r;
}

type Sink = { ok: (m: string) => void; warn: (m: string) => void; fail: (m: string) => void };

async function probe(db: Db): Promise<{ ok: boolean; error?: string }> {
  try {
    await db`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Turn a raw connection error into actionable guidance. */
function reachHint(error: string | undefined, c: ReturnType<typeof classifyConn>): string {
  const e = error ?? "unknown error";
  if (/network is unreachable|enetunreach|ehostunreach/i.test(e) && c.isSupabaseDirect)
    return "host resolves IPv6-only and there's no IPv6 route from here. Run sbmigrate from an IPv6-capable host, or enable the source's IPv4 add-on.";
  return e;
}

async function sourceChecks(source: Db, cfg: Config, s: Sink): Promise<void> {
  log.step("doctor: source readiness");

  const [wal] = await source`SHOW wal_level`;
  wal?.wal_level === "logical"
    ? s.ok("source wal_level=logical")
    : s.fail(`source wal_level=${wal?.wal_level} (need 'logical')`);

  // replica identity per published table
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const [row] = await source`
      SELECT c.relreplident,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS has_pk
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema ?? ""} AND c.relname = ${table ?? ""}`;
    if (!row) {
      s.fail(`published table ${qt} not found on source`);
      continue;
    }
    const good =
      (row.relreplident === "d" && row.has_pk) ||
      row.relreplident === "f" ||
      row.relreplident === "i";
    good
      ? s.ok(`${qt} replica identity ok (${row.relreplident === "d" ? "PK" : row.relreplident})`)
      : s.fail(
          `${qt} has no replica identity — UPDATE/DELETE won't replicate (set REPLICA IDENTITY FULL)`,
        );
  }

  // reconcile hashColumns ↔ live schema
  for (const t of cfg.reconcile.tables) {
    const [schema, table] = t.name.split(".");
    const cols = await source`
      SELECT column_name, is_generated FROM information_schema.columns
      WHERE table_schema = ${schema ?? ""} AND table_name = ${table ?? ""}`;
    if (cols.length === 0) {
      s.fail(`reconcile table ${t.name} not found on source`);
      continue;
    }
    const nonGen = cols.filter((c) => c.is_generated === "NEVER").map((c) => String(c.column_name));
    const gen = cols.filter((c) => c.is_generated === "ALWAYS").map((c) => String(c.column_name));
    const d = diffHashColumns(t.hashColumns, nonGen, gen);
    if (!t.hashColumns) {
      s.ok(
        `${t.name} reconcile auto-hashes ${nonGen.length} non-generated cols (${gen.length} generated excluded)`,
      );
    } else if (d.nonexistent.length || d.generatedPinned.length) {
      if (d.nonexistent.length)
        s.fail(`${t.name} hashColumns reference missing columns: ${d.nonexistent.join(", ")}`);
      if (d.generatedPinned.length)
        s.fail(
          `${t.name} hashColumns include GENERATED columns (false mismatch): ${d.generatedPinned.join(", ")}`,
        );
    } else if (d.missingFromPinned.length) {
      s.warn(
        `${t.name} hashColumns omit live columns (divergence there won't be caught): ${d.missingFromPinned.join(", ")}`,
      );
    } else {
      s.ok(
        `${t.name} hashColumns match live schema (${t.hashColumns.length} cols, ${gen.length} generated excluded)`,
      );
    }
  }

  // stale leftovers from a prior run
  const [slot] =
    await source`SELECT 1 FROM pg_replication_slots WHERE slot_name = ${cfg.replication.slot}`;
  slot
    ? s.warn(`slot ${cfg.replication.slot} already exists on source — teardown a prior run first`)
    : s.ok(`no stale slot (${cfg.replication.slot})`);
  const [pub] =
    await source`SELECT 1 FROM pg_publication WHERE pubname = ${cfg.replication.publication}`;
  if (pub) s.warn(`publication ${cfg.replication.publication} already exists on source`);

  // row counts (informational — drives copy-time + WAL expectations)
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const [c] = await source`
      SELECT n_live_tup FROM pg_stat_user_tables WHERE schemaname = ${schema ?? ""} AND relname = ${table ?? ""}`;
    log.detail(`${qt}: ~${c?.n_live_tup ?? "?"} live rows`);
  }
}

async function targetChecks(
  source: Db,
  target: Db,
  cfg: Config,
  sourceReachable: boolean,
  s: Sink,
): Promise<void> {
  log.step("doctor: target readiness");

  const [tgtV] = await target`SHOW server_version_num`;
  const tgtNum = Number(tgtV?.server_version_num ?? 0);
  if (sourceReachable) {
    const [srcV] = await source`SHOW server_version_num`;
    const srcNum = Number(srcV?.server_version_num ?? 0);
    log.detail(`source PG ${srcNum} / target PG ${tgtNum}`);
    if (tgtNum < srcNum)
      s.warn(
        "target major version is older than source — logical replication may reject some types",
      );
    else s.ok("target version ≥ source");
  }

  const [sub] = await target`
    SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
           pg_has_role(current_user, 'pg_create_subscription', 'MEMBER') AS has_grant`;
  if (sub?.is_super || sub?.has_grant) s.ok("target role can CREATE SUBSCRIPTION");
  else if (tgtNum < 160000)
    s.warn("PG15 target + non-superuser — CREATE SUBSCRIPTION may be blocked; smoke-test it");
  else s.fail("target role lacks pg_create_subscription membership");

  // is the schema loaded on the target yet? (logical replication does NOT carry DDL)
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const [row] = await target`
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema ?? ""} AND c.relname = ${table ?? ""} AND c.relkind = 'r'`;
    row
      ? s.ok(`target table ${qt} exists (schema loaded)`)
      : s.fail(
          `target table ${qt} MISSING — load the schema on the target before replicate (DDL is not replicated)`,
        );
  }
}
