import postgres from "postgres";
import type { Db } from "../db.ts";

/**
 * Single-source connection for the source-only upgrade commands (doctor / capture).
 * No migrate.config.yaml and no TARGET_DB_URL is required for those - the
 * upgrade audit only ever talks to the project being upgraded.
 */
export function connectSourceOnly(url: string): Db {
  return postgres(url, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 15,
    connection: {
      statement_timeout: 0,
      TimeZone: "UTC",
      DateStyle: "ISO, YMD",
    },
  });
}

/** Resolve the source URL for upgrade commands: --db-url flag wins, then env. */
export function resolveSourceUrl(flag: string | undefined): string {
  const url = flag ?? process.env.SOURCE_DB_URL;
  if (!url) {
    throw new Error(
      "no source database URL - pass --db-url or set SOURCE_DB_URL (env or --env-file)",
    );
  }
  return url;
}

/**
 * Data-driven Supabase detection. classifyConn(url) only recognizes the hosted
 * *.supabase.co domains - a LOCAL `supabase start` instance (127.0.0.1:54322)
 * looks "generic" by host but is platform-shaped in every way that matters
 * (managed schemas, platform roles, default extensions). Presence of the auth
 * schema + the supabase_admin role is the reliable marker, hosted or local.
 */
export async function isSupabaseProject(db: Db): Promise<boolean> {
  const [r] = await db`
    SELECT (SELECT count(*) FROM pg_namespace WHERE nspname = 'auth') > 0
       AND (SELECT count(*) FROM pg_roles WHERE rolname = 'supabase_admin') > 0 AS is_sb`;
  return Boolean(r?.is_sb);
}
