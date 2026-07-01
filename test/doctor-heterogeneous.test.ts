import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema, type Secrets } from "../src/config.ts";
import type { MySqlConn } from "../src/engine/mysql.ts";
import type { SqlServerConn } from "../src/engine/sqlserver.ts";
import { log } from "../src/log.ts";
import { doctor } from "../src/steps/doctor.ts";

// doctor logs to stderr; silence it for a clean test run.
log.toFile("/dev/null");

const mysqlCfg = (): Config =>
  ConfigSchema.parse({
    source: { engine: "mysql", serverId: 1, databases: ["inventory"] },
    target: { ref: "doctor-het-target-ref0" },
    replication: { tables: ["inventory.customers"], publication: "t" },
    reconcile: { tables: [{ name: "inventory.customers" }] },
    watchdog: {},
  });

const secrets = (): Secrets =>
  ({
    SOURCE_DB_URL: "mysql://u:p@127.0.0.1:3306/inventory",
    TARGET_DB_URL: "postgresql://postgres:pw@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres",
  }) as Secrets;

/** A fake MySQL responder keyed by a substring of the probe SQL. */
function fakeMy(responder: (sql: string) => Record<string, unknown>[]): {
  connect: (url: string) => Promise<MySqlConn>;
} {
  return {
    connect: async () => ({
      // biome-ignore lint/suspicious/noExplicitAny: shaped test rows
      async query<T = any>(sql: string): Promise<T[]> {
        return responder(sql) as T[];
      },
      async end() {},
    }),
  };
}

const healthyResponder = (sql: string): Record<string, unknown>[] => {
  if (sql.includes("SHOW GRANTS"))
    return [{ g: "GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO `dbz`@`%`" }];
  if (sql.includes("@@log_bin"))
    return [{ log_bin: 1, binlog_format: "ROW", binlog_row_image: "FULL" }];
  if (sql.includes("@@gtid_mode")) return [{ gtid_mode: "ON", enforce_gtid_consistency: "ON" }];
  if (sql.includes("@@binlog_row_value_options")) return [{ binlog_row_value_options: "" }];
  if (sql.includes("@@binlog_expire_logs_seconds"))
    return [{ "@@binlog_expire_logs_seconds": 86400 }];
  return [];
};

describe("doctor — heterogeneous MySQL source (live engine-prep checks)", () => {
  test("a healthy MySQL source passes the asserted checks (retention is a manual warn)", async () => {
    const r = await doctor(mysqlCfg(), secrets(), {
      sourceOnly: true,
      mysqlConnect: fakeMy(healthyResponder).connect,
    });
    expect(r.fail).toBe(0);
    // binlog_enabled + gtid + row_value_options + grants all pass; retention → 1 manual warn.
    expect(r.pass).toBeGreaterThanOrEqual(4);
    expect(r.warn).toBeGreaterThanOrEqual(1);
  });

  test("STATEMENT binlog + missing grant + gtid OFF: fails the fail-severity items, warns gtid", async () => {
    const bad = (sql: string): Record<string, unknown>[] => {
      if (sql.includes("SHOW GRANTS")) return [{ g: "GRANT SELECT ON *.* TO x" }]; // no REPLICATION
      if (sql.includes("@@log_bin"))
        return [{ log_bin: 1, binlog_format: "STATEMENT", binlog_row_image: "MINIMAL" }];
      if (sql.includes("@@gtid_mode"))
        return [{ gtid_mode: "OFF", enforce_gtid_consistency: "OFF" }];
      if (sql.includes("@@binlog_row_value_options"))
        return [{ binlog_row_value_options: "PARTIAL_JSON" }];
      if (sql.includes("@@binlog_expire_logs_seconds"))
        return [{ "@@binlog_expire_logs_seconds": 0 }];
      return [];
    };
    const r = await doctor(mysqlCfg(), secrets(), {
      sourceOnly: true,
      mysqlConnect: fakeMy(bad).connect,
    });
    // user_grants (fail) + binlog_enabled (fail) = 2 fails minimum
    expect(r.fail).toBeGreaterThanOrEqual(2);
    // gtid_mode (warn) + binlog_row_value_options (warn) + retention (warn)
    expect(r.warn).toBeGreaterThanOrEqual(2);
  });

  test("an UNREACHABLE MySQL source is a single fail, not a crash", async () => {
    const r = await doctor(mysqlCfg(), secrets(), {
      sourceOnly: true,
      mysqlConnect: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:3306");
      },
    });
    expect(r.fail).toBe(1);
  });
});

const sqlServerCfg = (): Config =>
  ConfigSchema.parse({
    source: { engine: "sqlserver", databases: ["inventory"] },
    target: { ref: "doctor-het-target-ref0" },
    replication: { tables: ["dbo.customers"], publication: "t" },
    reconcile: { tables: [{ name: "dbo.customers" }] },
    watchdog: {},
  });

const ssSecrets = (): Secrets =>
  ({
    SOURCE_DB_URL: "sqlserver://sa:pw@127.0.0.1:1433/inventory",
    TARGET_DB_URL: "postgresql://postgres:pw@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres",
  }) as Secrets;

function fakeSs(responder: (sql: string) => Record<string, unknown>[]): {
  connect: (url: string) => Promise<SqlServerConn>;
} {
  return {
    connect: async () => ({
      // biome-ignore lint/suspicious/noExplicitAny: shaped test rows
      async query<T = any>(sql: string): Promise<T[]> {
        return responder(sql) as T[];
      },
      async end() {},
    }),
  };
}

describe("doctor — heterogeneous SQL Server source (live engine-prep checks)", () => {
  test("a CDC-enabled Enterprise source passes the asserted checks", async () => {
    const healthy = (sql: string): Record<string, unknown>[] => {
      if (sql.includes("tier_ok")) return [{ tier_ok: "ok" }]; // edition 3 => off-Azure => gate N/A
      if (sql.includes("EngineEdition")) return [{ edition: "3" }];
      if (sql.includes("is_cdc_enabled")) return [{ is_cdc_enabled: "1" }];
      return [];
    };
    const r = await doctor(sqlServerCfg(), ssSecrets(), {
      sourceOnly: true,
      sqlServerConnect: fakeSs(healthy).connect,
    });
    expect(r.fail).toBe(0);
    expect(r.pass).toBeGreaterThanOrEqual(3); // flavour + azure_tier + cdc_enable asserts pass
  });

  test("Express edition + CDC disabled: both fail-severity asserts fail", async () => {
    const bad = (sql: string): Record<string, unknown>[] => {
      if (sql.includes("tier_ok")) return [{ tier_ok: "ok" }]; // Express is off-Azure => gate N/A
      if (sql.includes("EngineEdition")) return [{ edition: "4" }]; // Express - no CDC
      if (sql.includes("is_cdc_enabled")) return [{ is_cdc_enabled: "0" }];
      return [];
    };
    const r = await doctor(sqlServerCfg(), ssSecrets(), {
      sourceOnly: true,
      sqlServerConnect: fakeSs(bad).connect,
    });
    expect(r.fail).toBeGreaterThanOrEqual(2);
  });

  test("Azure SQL DB on a blocked DTU tier (S2) fails the tier gate", async () => {
    const blockedTier = (sql: string): Record<string, unknown>[] => {
      if (sql.includes("tier_ok")) return [{ tier_ok: "blocked" }]; // EngineEdition 5 + S2
      if (sql.includes("EngineEdition")) return [{ edition: "5" }]; // Azure SQL DB
      if (sql.includes("is_cdc_enabled")) return [{ is_cdc_enabled: "1" }];
      return [];
    };
    const r = await doctor(sqlServerCfg(), ssSecrets(), {
      sourceOnly: true,
      sqlServerConnect: fakeSs(blockedTier).connect,
    });
    expect(r.fail).toBeGreaterThanOrEqual(1); // the azure_tier gate fires before connector start
  });

  test("an UNREACHABLE SQL Server source is a single fail, not a crash", async () => {
    const r = await doctor(sqlServerCfg(), ssSecrets(), {
      sourceOnly: true,
      sqlServerConnect: async () => {
        throw new Error("ETIMEOUT 127.0.0.1:1433");
      },
    });
    expect(r.fail).toBe(1);
  });
});
