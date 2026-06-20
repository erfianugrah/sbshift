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

  /** Which config sections to copy via the Management API. */
  configSync: z
    .object({
      auth: z.boolean().default(true),
      realtime: z.boolean().default(true),
      postgrest: z.boolean().default(true),
      storage: z.boolean().default(true),
      dbPooler: z.boolean().default(true),
      dbPostgres: z.boolean().default(false),
      /** Copy SSL enforcement (GET → PUT /ssl-enforcement). */
      sslEnforcement: z.boolean().default(false),
      /** Copy DB network restrictions / allowed CIDRs (GET → POST /network-restrictions/apply). */
      networkRestrictions: z.boolean().default(false),
      /**
       * Copy auth INTEGRATION secrets (SMTP/OAuth/SMS/hook creds) instead of
       * stripping them. Off by default. NOTE: the JWT signing secret + API keys
       * are NEVER copied regardless (new project = new keys) — those live on
       * separate endpoints this tool does not call.
       */
      secrets: z.boolean().default(false),
      /** Copy project (Edge Function) secrets via the bulk /secrets endpoint. Plaintext — opt-in. */
      projectSecrets: z.boolean().default(false),
      /** Recreate third-party-auth integrations (Firebase/Auth0/Cognito/Clerk JWT) on the target. */
      thirdPartyAuth: z.boolean().default(false),
      /** Recreate SSO/SAML providers (entity, metadata, domains, attribute mapping) on the target. */
      ssoProviders: z.boolean().default(false),
    })
    .default({
      auth: true,
      realtime: true,
      postgrest: true,
      storage: true,
      dbPooler: true,
      dbPostgres: false,
      sslEnforcement: false,
      networkRestrictions: false,
      secrets: false,
      projectSecrets: false,
      thirdPartyAuth: false,
      ssoProviders: false,
    }),

  /**
   * Billable infra to copy SOURCE → TARGET via the `provision` command. All
   * default OFF — every one of these CHANGES THE TARGET'S BILL. `provision`
   * previews by default and only mutates with --confirm. It ADDS/UPGRADES the
   * target to match the source; it never strips addons the target already has.
   */
  provision: z
    .object({
      /** Match compute instance size (ci_micro…ci_xlarge). */
      compute: z.boolean().default(false),
      /** Match Point-in-Time-Recovery addon (pitr_7/14/28). */
      pitr: z.boolean().default(false),
      /** Match dedicated IPv4 addon. */
      ipv4: z.boolean().default(false),
      /** Match disk attributes (size_gb / iops / throughput / type). */
      disk: z.boolean().default(false),
      /** Match daily backup schedule time (Enterprise plan only). */
      backupSchedule: z.boolean().default(false),
    })
    .default({ compute: false, pitr: false, ipv4: false, disk: false, backupSchedule: false }),

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

export interface EnvFileResult {
  /** keys set from the file */
  applied: string[];
  /** keys whose inherited process.env value DIFFERED and was overridden */
  conflicts: string[];
}

/** Parse a dotenv-style file into key/value pairs. Pure, testable. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = body.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load a dotenv-style file and apply it to `process.env`, OVERRIDING any
 * inherited variable of the same name, and report which inherited values it
 * actually changed.
 *
 * This is deliberately override-wins (unlike Bun's auto-loaded `.env`, which
 * does NOT override an already-set process.env var). A migration tool must not
 * silently use a SOURCE_DB_URL leaked from the launching shell when the user
 * pointed it at an explicit secrets file — that's how you migrate the wrong
 * database. The CLI surfaces `conflicts` as a warning so the override is never
 * silent.
 *
 * Format: KEY=VALUE per line; blank lines and `#` comments ignored; surrounding
 * single/double quotes stripped; `export ` prefix tolerated. No interpolation.
 */
export function applyEnvFile(path: string): EnvFileResult {
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  const applied: string[] = [];
  const conflicts: string[] = [];
  for (const [key, val] of Object.entries(parsed)) {
    const prior = process.env[key];
    if (prior !== undefined && prior !== val) conflicts.push(key);
    process.env[key] = val;
    applied.push(key);
  }
  return { applied, conflicts };
}

/**
 * Load ONLY the Supabase access token from the environment. For Management-API
 * commands that don't (yet) have SOURCE/TARGET connection strings — e.g.
 * `sandbox up`, which CREATES the projects those URLs will point at.
 */
export function loadToken(): string {
  const tok = process.env.SUPABASE_ACCESS_TOKEN;
  if (!tok?.startsWith("sbp_")) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN (sbp_…) is required for this command (Management API). " +
        "Set it in .env or pass --env-file.",
    );
  }
  return tok;
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
