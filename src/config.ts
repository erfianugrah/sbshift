import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** A Postgres/SQL identifier we will interpolate into DDL. Strict allowlist. */
const Ident = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a bare SQL identifier (no quoting, no dots)");

/** schema-qualified table, e.g. public.documents */
const QualifiedTable = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/, "must be schema.table");

const ReconcileTable = z.object({
  /** schema.table */
  name: QualifiedTable,
  /**
   * Columns to include in the content hash. Omit to auto-detect all columns
   * EXCEPT generated columns (which logical replication recomputes on the
   * subscriber and must never be hashed — see search_vector gotcha).
   */
  hashColumns: z.array(Ident).optional(),
});

export const ConfigSchema = z.object({
  /** Supabase project ref of the SOURCE project (for the Management API). */
  source: z.object({ ref: z.string().min(15) }),
  /** Supabase project ref of the TARGET project (for the Management API). */
  target: z.object({ ref: z.string().min(15) }),

  replication: z.object({
    publication: Ident.default("region_migration"),
    slot: Ident.default("region_migration_slot"),
    subscription: Ident.default("region_migration_sub"),
    /** schema-qualified tables to publish. FOR ALL TABLES needs superuser — we always enumerate. */
    tables: z.array(QualifiedTable).min(1),
    /** copy_data=true lets the subscription do a consistent initial copy. Keep true unless using pgcopydb. */
    copyData: z.boolean().default(true),
  }),

  reconcile: z.object({
    tables: z.array(ReconcileTable).min(1),
    /** Path to the append-only ledger of ids written by the rehearsal writer. */
    ledgerPath: z.string().optional(),
    /** Table the ledger ids belong to (schema.table) and the id column name. */
    ledgerTable: QualifiedTable.optional(),
    ledgerIdColumn: Ident.default("id"),
  }),

  watchdog: z.object({
    /** Abort the watch if the source retains more than this much WAL for the slot. */
    maxRetainedWalMb: z.number().int().positive().default(2048),
    pollIntervalSec: z.number().int().positive().default(5),
    /** Max minutes to wait for initial sync to reach 'r' before giving up. */
    syncTimeoutMin: z.number().int().positive().default(240),
  }),

  /** Which config sections to copy via the Management API. Secrets are always stripped. */
  configSync: z
    .object({
      auth: z.boolean().default(true),
      realtime: z.boolean().default(true),
      postgrest: z.boolean().default(true),
      storage: z.boolean().default(true),
      dbPooler: z.boolean().default(true),
      dbPostgres: z.boolean().default(false),
    })
    .default({
      auth: true,
      realtime: true,
      postgrest: true,
      storage: true,
      dbPooler: true,
      dbPostgres: false,
    }),

  storage: z.object({ buckets: z.array(z.string()).default([]) }).default({ buckets: [] }),
  functions: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Secrets never live in the YAML — they come from the environment. */
export const SecretsSchema = z.object({
  /** Connection string for the SOURCE db used by pgshift's own admin/seed/reconcile
   *  queries. Normally the direct host; may be the IPv4 pooler when running from a
   *  host without IPv6 to the direct host (then set SOURCE_REPLICATION_URL too). */
  SOURCE_DB_URL: z.string().url(),
  /** Connection string for the TARGET db (admin queries + CREATE SUBSCRIPTION). */
  TARGET_DB_URL: z.string().url(),
  /** OPTIONAL override for the subscription's CONNECTION string (the one the TARGET's
   *  walreceiver dials to stream WAL). MUST be the source DIRECT host — the pooler
   *  cannot stream logical replication. Set this when SOURCE_DB_URL is a pooler
   *  (e.g. running pgshift from a host with no IPv6 route to the direct host); the
   *  target reaches the direct host over Supabase's internal network regardless.
   *  Falls back to SOURCE_DB_URL when unset. */
  SOURCE_REPLICATION_URL: z.string().url().optional(),
  /** Supabase personal access token (sbp_...) for the Management API. */
  SUPABASE_ACCESS_TOKEN: z.string().startsWith("sbp_").optional(),
});

export type Secrets = z.infer<typeof SecretsSchema>;

export function loadConfig(path: string): Config {
  const raw = parseYaml(readFileSync(path, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function loadSecrets(requireToken = false): Secrets {
  const parsed = SecretsSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Missing/invalid environment secrets:\n${z.prettifyError(parsed.error)}`);
  }
  if (requireToken && !parsed.data.SUPABASE_ACCESS_TOKEN) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required for this command (Management API).");
  }
  return parsed.data;
}
