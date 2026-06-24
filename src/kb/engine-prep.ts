import { type SourcePrepEngine, type SourcePrepItem, SourcePrepItems } from "./schema.ts";

/**
 * Source-prep playbooks for the heterogeneous engines (HETEROGENEOUS.md §5 priority order:
 * MySQL first, then SQL Server / Azure SQL). Each item is the §7 / §7b worked playbook
 * promoted to validated data: what an operator must do to a MySQL / SQL Server source before a
 * Debezium ReplicationEngine can stream it into Postgres/Supabase.
 *
 * `detect`/`verify` SQL is source-engine SQL (MySQL / T-SQL) and is documentation-grade today
 * — `pgshift guide <engine>` prints these; nothing executes them until the DebeziumEngine
 * runtime ships a driver. Provenance is the Debezium connector reference + vendor docs (the
 * authoritative CDC-out-of-engine source), so `kb drift` can age-check them like every other
 * KB item.
 */
const MYSQL: SourcePrepItem[] = [
  {
    id: "mysql.user_grants",
    engine: "mysql",
    phase: "source-prep",
    severity: "fail",
    klass: "assisted",
    title: "MySQL CDC user grants",
    guidance:
      "Create a dedicated CDC user with the minimum grants the Debezium connector needs:\n" +
      "  CREATE USER 'pgshift'@'%' IDENTIFIED BY '<pw>';\n" +
      "  GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT\n" +
      "    ON *.* TO 'pgshift'@'%';\n" +
      "  FLUSH PRIVILEGES;",
    detect: { sql: "SHOW GRANTS FOR CURRENT_USER" },
    verify: {
      sql: "SHOW GRANTS FOR CURRENT_USER",
      expect: "includes REPLICATION SLAVE + REPLICATION CLIENT",
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.binlog_enabled",
    engine: "mysql",
    phase: "source-prep",
    severity: "fail",
    klass: "assisted",
    title: "MySQL binlog enabled (ROW + FULL)",
    guidance:
      "Enable row-based binary logging (my.cnf, requires a server restart):\n" +
      "  server-id        = <unique-id>   # SELECT @@server_id; must be unique in the cluster\n" +
      "  log_bin          = mysql-bin\n" +
      "  binlog_format    = ROW\n" +
      "  binlog_row_image = FULL",
    detect: { sql: "SELECT @@log_bin, @@binlog_format, @@binlog_row_image" },
    verify: {
      sql: "SELECT @@log_bin, @@binlog_format, @@binlog_row_image",
      expect: "1, ROW, FULL",
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.gtid_mode",
    engine: "mysql",
    phase: "source-prep",
    severity: "warn",
    klass: "assisted",
    title: "MySQL GTID mode",
    guidance:
      "GTIDs let the connector fail over to a replica and enable read-only incremental " +
      "snapshots:\n" +
      "  SET @@GLOBAL.enforce_gtid_consistency = ON;\n" +
      "  SET @@GLOBAL.gtid_mode = ON;   -- on a live server, ramp OFF→OFF_PERMISSIVE→ON_PERMISSIVE→ON",
    detect: { sql: "SELECT @@gtid_mode, @@enforce_gtid_consistency" },
    verify: { sql: "SELECT @@gtid_mode, @@enforce_gtid_consistency", expect: "ON, ON" },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.binlog_retention",
    engine: "mysql",
    phase: "source-prep",
    severity: "fail",
    klass: "assisted",
    title: "MySQL binlog retention",
    guidance:
      "Binlogs must survive long enough to cover the snapshot + catch-up window.\n" +
      "  Self-hosted: set binlog_expire_logs_seconds ≥ expected snapshot duration.\n" +
      "  RDS / Aurora MySQL: automated backups must be ON (binlog requires them), then\n" +
      "    CALL mysql.rds_set_configuration('binlog retention hours', 168);",
    detect: { sql: "SELECT @@binlog_expire_logs_seconds" },
    verify: {
      sql: "SELECT @@binlog_expire_logs_seconds   -- or CALL mysql.rds_show_configuration (RDS)",
      expect: "≥ expected snapshot duration",
    },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.binlog_row_value_options",
    engine: "mysql",
    phase: "source-prep",
    severity: "warn",
    klass: "assisted",
    title: "MySQL binlog_row_value_options empty",
    guidance:
      "binlog_row_value_options must be empty, not PARTIAL_JSON — otherwise the connector " +
      "cannot see full JSON column changes.",
    detect: { sql: "SELECT @@binlog_row_value_options" },
    verify: { sql: "SELECT @@binlog_row_value_options", expect: "'' (empty)" },
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.schema_translation",
    engine: "mysql",
    phase: "snapshot",
    severity: "fail",
    klass: "guided",
    title: "MySQL → Postgres schema translation",
    guidance:
      "Draft target Postgres DDL from the MySQL information_schema and ratify the type " +
      "decisions a human must make (defaults are the documented Debezium mappings):\n" +
      "  TINYINT(1)     → boolean (Debezium converter) — but 0–127 storage should stay smallint; ASK\n" +
      "  UNSIGNED INT   → bigint (widen);  UNSIGNED BIGINT → numeric\n" +
      "  ENUM / SET     → text + optional CHECK; flag for review\n" +
      "  zero-dates     → NULL (Debezium zero-date fallback); confirm per column\n" +
      "  DATETIME/TIMESTAMP → timestamptz with the source session tz pinned\n" +
      "  DECIMAL        → numeric(p,s) preserved; warn on decimal.handling.mode rounding\n" +
      "Never auto-applies: writes migration/<run>/target-schema.sql, records each decision, and " +
      "gates cutover behind explicit sign-off.",
    provenance: {
      source: "https://debezium.io/documentation/reference/stable/connectors/mysql.html",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "mysql.identity_resync",
    engine: "mysql",
    phase: "cutover",
    severity: "fail",
    klass: "auto",
    title: "MySQL AUTO_INCREMENT → Postgres identity resync",
    guidance:
      "AUTO_INCREMENT values do not replicate. After CDC catch-up, set each Postgres " +
      "IDENTITY/sequence to MAX(pk)+1 before traffic flips (the heterogeneous analogue of the " +
      "native sequence-resync in cutover).",
    verify: {
      sql: "SELECT last_value FROM pg_sequences   -- target",
      expect: "last_value ≥ max(pk) per mapped table",
    },
    provenance: {
      // the remediation is a Postgres setval on the target identity, same as native cutover
      source: "/docs/postgres/view-pg-sequences.md",
      lastSynced: "2026-06-24",
    },
  },
];

/** Validated at module load — a malformed item crashes loudly, never silently skips. */
export const sourcePrep: readonly SourcePrepItem[] = SourcePrepItems.parse(MYSQL);

/** All heterogeneous engines that have a source-prep playbook (drives CLI validation + help). */
export function preppableEngines(
  items: readonly SourcePrepItem[] = sourcePrep,
): SourcePrepEngine[] {
  const seen = new Set<SourcePrepEngine>();
  for (const i of items) seen.add(i.engine);
  return [...seen];
}

/** The source-prep items for one engine, in catalog order. */
export function sourcePrepFor(
  engine: SourcePrepEngine,
  items: readonly SourcePrepItem[] = sourcePrep,
): SourcePrepItem[] {
  return items.filter((i) => i.engine === engine);
}
