import postgres, { type Sql } from "postgres";
import type { Secrets } from "./config.ts";
import { log } from "./log.ts";

export type Db = Sql;

/**
 * Quote a SQL identifier for safe interpolation into `.unsafe()` DDL.
 * Postgres folds unquoted identifiers to lowercase and rejects ones with
 * hyphens / reserved words, so any identifier coming from user config
 * (publication / slot / subscription / table names) must be quoted.
 */
export const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Connection-shaped errors (network blip, server restart, idle drop) are worth
// retrying; a SQL error (bad query, constraint) is NOT — it would just fail again.
// Match on message OR SQLSTATE: 08xxx = connection exceptions, 57P0x = admin
// shutdown / crash. Everything else propagates immediately.
const TRANSIENT =
  /econnreset|epipe|etimedout|enetunreach|ehostunreach|connection.*(clos|end|terminat|reset|timeout)|write CONNECTION|read CONNECTION|connect_timeout|CONNECTION_(CLOSED|ENDED|DESTROYED|CONNECT_TIMEOUT)/i;
const TRANSIENT_SQLSTATE = /^(08\d\d\d|57P0[123])$/;

export function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code =
    e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  return TRANSIENT.test(msg) || TRANSIENT_SQLSTATE.test(code);
}

/**
 * Run a query-producing fn, retrying ONLY transient connection errors with
 * exponential backoff. For long phases (reconcile's multi-minute table scans,
 * watch's hours-long poll) a single network blip should not abort the operation.
 *
 * L-12: parameter renamed from `max` to `maxAttempts` to avoid ambiguity
 * (max=1 means 1 attempt, 0 retries — not "max 1 retry").
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts || !isTransient(e)) throw e;
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(
        `${label}: transient error (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms: ${msg}`,
      );
      await sleep(backoffMs);
    }
  }
}

/**
 * Create source + target clients. Logical replication setup needs a DIRECT
 * connection (port 5432, db.<ref>.supabase.co) — NOT the pooler. We keep the
 * pool small; this tool issues administrative statements, not app traffic.
 */
export function connect(
  secrets: Secrets,
  opts: { connectTimeoutSec?: number } = {},
): { source: Db; target: Db; close: () => Promise<void> } {
  const pgOpts = {
    max: 3,
    idle_timeout: 20,
    connect_timeout: opts.connectTimeoutSec ?? 30,
    // Canonical GUCs applied to EVERY connection in both pools. Two reasons:
    //  1. Correctness: reconcile hashes `row::text`, whose rendering depends on
    //     TimeZone / DateStyle / extra_float_digits / bytea_output / IntervalStyle.
    //     Source and target are different projects (different regions) — if any of
    //     these differ, identical data hashes differently => FALSE reconcile
    //     mismatch. Pinning them identically on both sides makes the hash stable.
    //  2. Resilience: a full-table hash scan over a large (100s of GB) table runs for minutes;
    //     Supabase sets a default statement_timeout that would kill it mid-scan.
    connection: {
      statement_timeout: 0,
      idle_in_transaction_session_timeout: 0,
      // M-2: 0 means DDL waits forever for a lock; 30 s covers normal contention
      // without blocking indefinitely if a long transaction holds the table lock.
      lock_timeout: 30_000,
      TimeZone: "UTC",
      DateStyle: "ISO, YMD",
      IntervalStyle: "postgres",
      extra_float_digits: "3",
      bytea_output: "hex",
    },
  };
  const source = postgres(secrets.SOURCE_DB_URL, pgOpts);
  const target = postgres(secrets.TARGET_DB_URL, pgOpts);
  return {
    source,
    target,
    close: async () => {
      await Promise.allSettled([source.end({ timeout: 5 }), target.end({ timeout: 5 })]);
    },
  };
}

/** What kind of endpoint a connection string points at — drives doctor warnings. */
export interface ConnInfo {
  host: string;
  port: number;
  /** Supavisor pooler host (…​.pooler.supabase.com) — CANNOT stream logical replication. */
  isPooler: boolean;
  /** Supavisor TRANSACTION-mode pooler (port 6543) — also breaks `pg_dump`/`pg_dumpall`
   *  (no session-level features), so it's unusable as `bootstrap`'s dump source. The
   *  session pooler (5432) is fine for dumps. */
  isTransactionPooler: boolean;
  /** Direct Supabase host (db.<ref>.supabase.co) — IPv6-only unless the IPv4 add-on is on. */
  isSupabaseDirect: boolean;
  /** project ref, when the host is a direct Supabase host. */
  ref?: string;
}

export function classifyConn(url: string): ConnInfo {
  const u = new URL(url);
  const host = u.hostname;
  const port = Number(u.port || "5432");
  const m = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(host);
  const isPooler = /(^|\.)pooler\.supabase\.com$/i.test(host);
  return {
    host,
    port,
    isPooler,
    isTransactionPooler: isPooler && port === 6543,
    isSupabaseDirect: Boolean(m),
    ref: m?.[1],
  };
}

/**
 * C-2 fix: use the raw URL as the libpq CONNECTION string.
 *
 * The previous keyword=value builder had unquoted values — a password containing
 * a space breaks libpq tokenisation before quoting can rescue it. PostgreSQL's
 * CREATE SUBSCRIPTION accepts URL format natively; percent-encoding in the URL
 * means no quoting layer is needed.
 *
 * Kept as a named export so callers are explicit about which URL they're using.
 * replicate.ts uses SOURCE_REPLICATION_URL (direct host) when set; this function
 * returns exactly that value so the caller's intent is clear.
 */
export function sourceConnUrl(secrets: Secrets): string {
  return secrets.SOURCE_REPLICATION_URL ?? secrets.SOURCE_DB_URL;
}
