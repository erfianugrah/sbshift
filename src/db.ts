import postgres, { type Sql } from "postgres";
import type { Secrets } from "./config.ts";

export type Db = Sql;

/**
 * Create source + target clients. Logical replication setup needs a DIRECT
 * connection (port 5432, db.<ref>.supabase.co) — NOT the pooler. We keep the
 * pool small; this tool issues administrative statements, not app traffic.
 */
export function connect(
  secrets: Secrets,
  opts: { connectTimeoutSec?: number } = {},
): { source: Db; target: Db; close: () => Promise<void> } {
  const pgOpts = { max: 3, idle_timeout: 20, connect_timeout: opts.connectTimeoutSec ?? 30 };
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
 * SOURCE. Derived from SOURCE_DB_URL so we never hand-maintain two formats.
 *
 * sslmode defaults to `require` (Supabase mandates TLS), but is overridable via
 * an `?sslmode=` query param on SOURCE_DB_URL so the integration tier can point
 * at a plain (non-TLS) Postgres with `?sslmode=disable`.
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
  const u = new URL(secrets.SOURCE_DB_URL);
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
