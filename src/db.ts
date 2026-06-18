import postgres, { type Sql } from "postgres";
import type { Secrets } from "./config.ts";

export type Db = Sql;

/**
 * Create source + target clients. Logical replication setup needs a DIRECT
 * connection (port 5432, db.<ref>.supabase.co) — NOT the pooler. We keep the
 * pool small; this tool issues administrative statements, not app traffic.
 */
export function connect(secrets: Secrets): { source: Db; target: Db; close: () => Promise<void> } {
  const opts = { max: 3, idle_timeout: 20, connect_timeout: 30 } as const;
  const source = postgres(secrets.SOURCE_DB_URL, opts);
  const target = postgres(secrets.TARGET_DB_URL, opts);
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
