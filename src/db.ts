import postgres, { type Sql } from "postgres";
import type { Secrets } from "./config.ts";
import { log } from "./log.ts";

export type Db = Sql;

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
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string, max = 4): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= max || !isTransient(e)) throw e;
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(
        `${label}: transient error (attempt ${attempt}/${max}), retrying in ${backoffMs}ms: ${msg}`,
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
    //  2. Resilience: a full-table hash scan over a large table runs for minutes;
    //     Supabase sets a default statement_timeout that would kill it mid-scan.
    connection: {
      statement_timeout: 0,
      idle_in_transaction_session_timeout: 0,
      lock_timeout: 0,
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

/**
 * The libpq-style CONNECTION string the TARGET subscription uses to reach the
 * SOURCE. Uses SOURCE_REPLICATION_URL when set (the source DIRECT host, required
 * because the pooler can't stream WAL), else SOURCE_DB_URL.
 *
 * sslmode defaults to `require` (Supabase mandates TLS), but is overridable via
 * an `?sslmode=` query param so the integration tier can point at a plain
 * (non-TLS) Postgres with `?sslmode=disable`.
 */
/** What kind of endpoint a connection string points at — drives doctor warnings. */
export interface ConnInfo {
  host: string;
  port: number;
  /** Supavisor pooler host (…​.pooler.supabase.com) — CANNOT stream logical replication. */
  isPooler: boolean;
  /** Direct Supabase host (db.<ref>.supabase.co) — IPv6-only unless the IPv4 add-on is on. */
  isSupabaseDirect: boolean;
  /** project ref, when the host is a direct Supabase host. */
  ref?: string;
}

export function classifyConn(url: string): ConnInfo {
  const u = new URL(url);
  const host = u.hostname;
  const m = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(host);
  return {
    host,
    port: Number(u.port || "5432"),
    isPooler: /(^|\.)pooler\.supabase\.com$/i.test(host),
    isSupabaseDirect: Boolean(m),
    ref: m?.[1],
  };
}

export function sourceConnString(secrets: Secrets): string {
  const u = new URL(secrets.SOURCE_REPLICATION_URL ?? secrets.SOURCE_DB_URL);
  const sslmode = u.searchParams.get("sslmode") || "require";
  const parts = [
    `host=${u.hostname}`,
    `port=${u.port || "5432"}`,
    `user=${decodeURIComponent(u.username)}`,
    `password=${decodeURIComponent(u.password)}`,
    `dbname=${u.pathname.replace(/^\//, "") || "postgres"}`,
    `sslmode=${sslmode}`,
  ];
  return parts.join(" ");
}
