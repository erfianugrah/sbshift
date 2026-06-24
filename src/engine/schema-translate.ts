/**
 * MySQL → Postgres schema translation (GUIDED-MIGRATION.md §7, the `guided` heart; HETEROGENEOUS.md
 * §2 item 4 — "the long pole"). Drafts target Postgres DDL from the MySQL `information_schema` and
 * surfaces the type decisions that need a human. NEVER auto-applies: the caller writes the draft
 * for review and cutover gates on sign-off (§9 caveat 1 — schema translation cannot be fully
 * automated).
 *
 * Pure (no IO): the type matrix + DDL rendering are unit-tested; the live drafter
 * (`draftTargetSchema`) just feeds `information_schema` rows in. Type mappings follow Debezium's
 * documented MySQL "Data type mappings".
 *
 * This is a FIRST CUT covering the common matrix + everything in the demo schema. Less-common
 * types (SET multi-value semantics, spatial, fractional-second precision, generated columns) are
 * drafted to a safe default and flagged for review rather than silently guessed.
 */

/** A row of MySQL `information_schema.columns` (the subset we read). */
export interface MySqlColumn {
  COLUMN_NAME: string;
  DATA_TYPE: string; // e.g. "int", "tinyint", "varchar", "datetime", "enum", "decimal"
  COLUMN_TYPE: string; // e.g. "int unsigned", "tinyint(1)", "varchar(255)", "decimal(10,2)"
  IS_NULLABLE: string; // "YES" | "NO"
  COLUMN_KEY: string; // "PRI" on a primary-key column
  EXTRA: string; // e.g. "auto_increment"
  CHARACTER_MAXIMUM_LENGTH: number | string | null;
  NUMERIC_PRECISION: number | string | null;
  NUMERIC_SCALE: number | string | null;
}

export interface TranslatedColumn {
  name: string;
  pgType: string;
  nullable: boolean;
  /** A human-review note (the `guided` decision) — present iff the mapping needs ratification. */
  review?: string;
}

const num = (v: number | string | null | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Translate one MySQL column to its Postgres type, flagging decisions a human must ratify. */
export function translateColumn(col: MySqlColumn): TranslatedColumn {
  const dt = col.DATA_TYPE.toLowerCase();
  const ct = col.COLUMN_TYPE.toLowerCase();
  const unsigned = ct.includes("unsigned");
  const nullable = col.IS_NULLABLE.toUpperCase() === "YES";
  const out = (pgType: string, review?: string): TranslatedColumn => ({
    name: col.COLUMN_NAME,
    pgType,
    nullable,
    ...(review ? { review } : {}),
  });

  switch (dt) {
    case "tinyint":
      return ct.startsWith("tinyint(1)")
        ? out("boolean", "TINYINT(1)→boolean (Debezium default); if it stores 0–127, use smallint")
        : out(unsigned ? "smallint" : "smallint");
    case "smallint":
      return out(unsigned ? "integer" : "smallint");
    case "mediumint":
      return out("integer");
    case "int":
    case "integer":
      return out(
        unsigned ? "bigint" : "integer",
        unsigned ? "INT UNSIGNED→bigint (widened)" : undefined,
      );
    case "bigint":
      return unsigned
        ? out("numeric", "BIGINT UNSIGNED→numeric (exceeds bigint range)")
        : out("bigint");
    case "decimal":
    case "numeric":
      return out(`numeric(${num(col.NUMERIC_PRECISION, 38)},${num(col.NUMERIC_SCALE, 0)})`);
    case "float":
      return out("real");
    case "double":
      return out("double precision");
    case "bit":
      return ct === "bit(1)" ? out("boolean") : out("bit varying", "BIT(n)→bit varying — review");
    case "char":
      return out(`char(${num(col.CHARACTER_MAXIMUM_LENGTH, 1)})`);
    case "varchar":
      return out(`varchar(${num(col.CHARACTER_MAXIMUM_LENGTH, 255)})`);
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext":
      return out("text");
    case "binary":
    case "varbinary":
    case "tinyblob":
    case "blob":
    case "mediumblob":
    case "longblob":
      return out("bytea");
    case "date":
      return out("date");
    case "datetime":
      return out("timestamptz", "DATETIME→timestamptz; pin the source session tz so values align");
    case "timestamp":
      return out("timestamptz");
    case "time":
      return out("time");
    case "year":
      return out("smallint", "YEAR→smallint");
    case "enum":
      return out("text", `ENUM (${ct})→text; add a CHECK constraint or native enum if desired`);
    case "set":
      return out("text", `SET (${ct})→text; SET is a comma-joined multi-value — review semantics`);
    case "json":
      return out("jsonb");
    case "geometry":
    case "point":
    case "linestring":
    case "polygon":
      return out("text", `spatial type '${dt}'→text; consider PostGIS geometry`);
    default:
      return out("text", `unmapped MySQL type '${dt}' (${ct})→text — REVIEW`);
  }
}

export interface TableDraft {
  /** `CREATE TABLE IF NOT EXISTS "public"."<table>" (...)`. */
  sql: string;
  /** Per-column review decisions (the `guided` gate) for this table. */
  decisions: { table: string; column: string; review: string }[];
}

/** Render the Postgres CREATE TABLE draft for one table from its translated columns + PK list. */
export function renderCreateTable(
  table: string,
  columns: MySqlColumn[],
  primaryKey: string[],
): TableDraft {
  const translated = columns.map(translateColumn);
  const lines = translated.map((c) => `  "${c.name}" ${c.pgType}${c.nullable ? "" : " NOT NULL"}`);
  if (primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${primaryKey.map((c) => `"${c}"`).join(", ")})`);
  }
  const sql = `CREATE TABLE IF NOT EXISTS "public"."${table}" (\n${lines.join(",\n")}\n);`;
  const decisions = translated
    .filter((c) => c.review)
    .map((c) => ({ table, column: c.name, review: c.review as string }));
  return { sql, decisions };
}

import type { MySqlConn } from "./mysql.ts";

export interface SchemaDraft {
  /** All CREATE TABLE statements, ready to apply to the (pre-migration) target. */
  sql: string;
  /** Every guided decision across all tables — the cutover sign-off gate (§9 caveat 1). */
  decisions: { table: string; column: string; review: string }[];
}

/**
 * Draft the target Postgres schema for the given MySQL `db.tables` by reading
 * `information_schema`. NEVER applies it — the caller writes it for review and gates cutover on
 * sign-off (GUIDED-MIGRATION.md §7). `db`/`tables` are config-validated bare idents.
 */
export async function draftTargetSchema(
  my: MySqlConn,
  db: string,
  tables: string[],
): Promise<SchemaDraft> {
  const drafts: TableDraft[] = [];
  for (const table of tables) {
    const cols = await my.query<MySqlColumn>(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA,
              CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = '${db}' AND TABLE_NAME = '${table}'
       ORDER BY ORDINAL_POSITION`,
    );
    if (cols.length === 0) {
      throw new Error(`schema-translate: ${db}.${table} has no columns — does the table exist?`);
    }
    const pk = await my.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = '${db}' AND TABLE_NAME = '${table}' AND CONSTRAINT_NAME = 'PRIMARY'
       ORDER BY ORDINAL_POSITION`,
    );
    drafts.push(
      renderCreateTable(
        table,
        cols,
        pk.map((r) => r.COLUMN_NAME),
      ),
    );
  }
  return {
    sql: drafts.map((d) => d.sql).join("\n\n"),
    decisions: drafts.flatMap((d) => d.decisions),
  };
}
