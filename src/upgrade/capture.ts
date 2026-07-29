import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import {
  dumpAuthDataCmd,
  dumpRolesCmd,
  dumpSchemaCmd,
  filterSupabaseRoles,
  filterSupabaseSchema,
  isSupabaseSource,
  redactArgv,
  SUPABASE_MANAGED_SCHEMAS,
} from "../steps/bootstrap.ts";
import { DB_SIZE_SQL, EXTENSION_INVENTORY_SQL, SERVER_VERSION_SQL } from "./kb.ts";
import { isSupabaseProject } from "./source.ts";

/**
 * `upgrade capture` - pull a complete logical snapshot (roles + schema + data)
 * out of the project being upgraded, for replay into the local pg_upgrade lab
 * (or any rehearsal environment). This is the small-to-medium-DB path: the
 * whole point is that a dump/restore round-trip is cheap at this scale, so we
 * guard on database size unless --force.
 *
 * The capture is self-describing: manifest.json records the source version,
 * size, and extension inventory so `upgrade lab` can sanity-check what it is
 * about to restore and `upgrade doctor` output can be compared pre/post.
 */

export interface CaptureManifest {
  capturedAt: string;
  serverVersion: string;
  sizeBytes: number;
  supabaseSource: boolean;
  allSchemas: boolean;
  withAuthData: boolean;
  extensions: { extname: string; extversion: string }[];
  files: string[];
}

/** Pure: pg_dump argv for a full DATA dump (mirrors dumpSchemaCmd's hygiene flags). */
export function dumpDataCmd(
  sourceUrl: string,
  file: string,
  excludeSchemas: string[] = [],
): string[] {
  return [
    "pg_dump",
    "--data-only",
    "--no-owner",
    "--no-privileges",
    ...excludeSchemas.flatMap((s) => [`--exclude-schema=${s}`]),
    "-d",
    sourceUrl,
    "-f",
    file,
  ];
}

/**
 * Pure: psql argv to restore a DATA dump with FK/trigger enforcement deferred.
 * Same trick as bootstrap's auth-data restore: cross-table FK ordering inside
 * a data-only dump is not guaranteed, so the load runs under
 * session_replication_role = replica. Single-transaction + stop-on-error so a
 * partial load never lands.
 */
export function restoreDataCmd(targetUrl: string, file: string): string[] {
  return [
    "psql",
    "--single-transaction",
    "--variable",
    "ON_ERROR_STOP=1",
    "--command",
    "SET session_replication_role = replica",
    "-f",
    file,
    "-d",
    targetUrl,
  ];
}

export interface CaptureOpts {
  outDir: string;
  /** Refuse to capture a database larger than this (GiB) unless force. */
  maxCaptureGb: number;
  force: boolean;
  /** Include Supabase-managed schemas (auth/storage/...) in schema+data dumps. */
  allSchemas?: boolean;
  /** ALSO dump the auth schema row data separately (deferred-FK restore file). */
  withAuthData?: boolean;
}

export interface CaptureResult {
  ok: boolean;
  manifestPath: string;
  sizeBytes: number;
}

async function spawnStep(label: string, cmd: string[]): Promise<void> {
  log.detail(`$ ${redactArgv(cmd)}`);
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

export async function upgradeCapture(
  db: Db,
  sourceUrl: string,
  opts: CaptureOpts,
): Promise<CaptureResult> {
  // Hosted *.supabase.co is recognized by URL; a LOCAL `supabase start`
  // instance (127.0.0.1:54322) is recognized by its platform shape (auth
  // schema + supabase_admin role) - both get managed-schema/role filtering.
  const supabase = isSupabaseSource(sourceUrl) || (await isSupabaseProject(db));
  const exclude = supabase && !opts.allSchemas ? [...SUPABASE_MANAGED_SCHEMAS] : [];

  log.step("upgrade capture: size guard");
  const [sizeRow] = await db.unsafe<{ bytes: string }[]>(DB_SIZE_SQL);
  const sizeBytes = Number(sizeRow?.bytes ?? 0);
  const gib = sizeBytes / 1_073_741_824;
  if (gib > opts.maxCaptureGb && !opts.force) {
    log.err(
      `database is ${gib.toFixed(2)} GiB - above the ${opts.maxCaptureGb} GiB capture guard. ` +
        "A dump/restore rehearsal stops being cheap at that scale; archive/drop first, " +
        "or re-run with --force if you really want the full capture.",
    );
    return { ok: false, manifestPath: "", sizeBytes };
  }
  log.ok(`database ${gib.toFixed(2)} GiB (guard ${opts.maxCaptureGb} GiB)`);

  mkdirSync(opts.outDir, { recursive: true });
  const rolesFile = `${opts.outDir}/roles.sql`;
  const schemaFile = `${opts.outDir}/schema.sql`;
  const dataFile = `${opts.outDir}/data.sql`;

  log.step(`upgrade capture: dumping to ${opts.outDir}/`);
  // Supabase sources: roles are dumped WITHOUT passwords, then filtered of
  // platform-reserved roles; schema DDL is filtered of managed-schema objects.
  // The data dump relies on --exclude-schema alone (row data has no DDL to filter).
  await spawnStep("roles dump", dumpRolesCmd(sourceUrl, rolesFile));
  if (supabase) writeFileSync(rolesFile, filterSupabaseRoles(readFileSync(rolesFile, "utf8")));
  await spawnStep("schema dump", dumpSchemaCmd(sourceUrl, schemaFile, exclude, supabase));
  if (supabase) writeFileSync(schemaFile, filterSupabaseSchema(readFileSync(schemaFile, "utf8")));
  await spawnStep("data dump", dumpDataCmd(sourceUrl, dataFile, exclude));

  const files = ["roles.sql", "schema.sql", "data.sql"];
  if (opts.withAuthData && !supabase) {
    log.warn(
      "--with-auth-data was set but the source is NOT a Supabase project (no auth schema to dump). " +
        "Ignoring --with-auth-data.",
    );
  }
  if (opts.withAuthData && supabase && opts.allSchemas) {
    log.warn(
      "--with-auth-data is redundant when --all-schemas is set (auth data is already in the full dump). " +
        "Ignoring --with-auth-data.",
    );
  }
  if (opts.withAuthData && supabase && !opts.allSchemas) {
    // The auth schema's DDL is needed to restore auth row data (and to satisfy
    // user tables that FK into auth.users) in an environment where the
    // platform does not pre-create it - i.e. the upgrade lab. On a real hosted
    // target the platform owns the auth schema; keep it a SEPARATE file so
    // restores can choose.
    const authSchemaFile = `${opts.outDir}/auth-schema.sql`;
    await spawnStep("auth schema dump", [
      "pg_dump",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--schema=auth",
      "-d",
      sourceUrl,
      "-f",
      authSchemaFile,
    ]);
    const authFile = `${opts.outDir}/auth.sql`;
    await spawnStep("auth data dump", dumpAuthDataCmd(sourceUrl, authFile, ["auth"]));
    files.push("auth-schema.sql", "auth.sql");
  }

  const [ver] = await db.unsafe(SERVER_VERSION_SQL);
  const exts = await db.unsafe<{ extname: string; extversion: string }[]>(EXTENSION_INVENTORY_SQL);
  const manifest: CaptureManifest = {
    capturedAt: new Date().toISOString(),
    serverVersion: String(ver?.server_version ?? "unknown"),
    sizeBytes,
    supabaseSource: supabase,
    allSchemas: Boolean(opts.allSchemas),
    withAuthData: Boolean(opts.withAuthData),
    extensions: exts.map((e) => ({ extname: e.extname, extversion: e.extversion })),
    files,
  };
  const manifestPath = `${opts.outDir}/manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log.ok(
    `capture complete: ${files.join(", ")} + manifest.json (${manifest.extensions.length} extensions, ${gib.toFixed(2)} GiB)`,
  );
  return { ok: true, manifestPath, sizeBytes };
}
