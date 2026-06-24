import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEnvFile,
  ConfigSchema,
  parseEnvFile,
  SecretsSchema,
  supabaseSourceRef,
} from "../src/config.ts";

const base = {
  source: { ref: "aaaaaaaaaaaaaaaaaaaa" },
  target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
  replication: { tables: ["public.documents", "public.aliases"] },
  reconcile: { tables: [{ name: "public.documents" }] },
  watchdog: {},
};

describe("ConfigSchema", () => {
  test("applies defaults for replication + watchdog + configSync", () => {
    const cfg = ConfigSchema.parse(base);
    expect(cfg.replication.publication).toBe("region_migration");
    expect(cfg.replication.slot).toBe("region_migration_slot");
    expect(cfg.replication.copyData).toBe(true);
    expect(cfg.watchdog.maxRetainedWalMb).toBe(2048);
    expect(cfg.configSync.auth).toBe(true);
    expect(cfg.configSync.dbPostgres).toBe(false);
    expect(cfg.storage.buckets).toEqual([]);
    expect(cfg.functions.enabled).toBe(false);
    expect(cfg.source.engine).toBe("postgres");
  });

  test("rejects an unknown source engine", () => {
    const bad = { ...base, source: { ref: "a".repeat(20), engine: "oracle" } };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  test("a legacy source with only a ref still parses as the postgres engine (back-compat)", () => {
    const cfg = ConfigSchema.parse(base); // base.source = { ref } — no engine declared
    expect(cfg.source.engine).toBe("postgres");
    if (cfg.source.engine === "postgres") expect(cfg.source.ref).toBe("aaaaaaaaaaaaaaaaaaaa");
  });

  test("a postgres source still requires a >=15-char ref", () => {
    const bad = { ...base, source: { engine: "postgres", ref: "tooshort" } };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  test("a mysql source parses with serverId + databases and NO ref", () => {
    const cfg = ConfigSchema.parse({
      ...base,
      source: { engine: "mysql", serverId: 184054, databases: ["inventory"] },
      replication: { tables: ["inventory.customers"] },
      reconcile: { tables: [{ name: "inventory.customers" }] },
    });
    expect(cfg.source.engine).toBe("mysql");
    if (cfg.source.engine === "mysql") {
      expect(cfg.source.serverId).toBe(184054);
      expect(cfg.source.databases).toEqual(["inventory"]);
    }
  });

  test("a mysql source rejects a missing serverId or empty databases", () => {
    const noServerId = { ...base, source: { engine: "mysql", databases: ["inventory"] } };
    const noDbs = { ...base, source: { engine: "mysql", serverId: 1, databases: [] } };
    expect(ConfigSchema.safeParse(noServerId).success).toBe(false);
    expect(ConfigSchema.safeParse(noDbs).success).toBe(false);
  });
});

describe("ConfigSchema (replication/reconcile guards)", () => {
  test("rejects a publication name that is not a bare identifier", () => {
    const bad = {
      ...base,
      replication: { tables: ["public.documents"], publication: "drop;table" },
    };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an unqualified table name", () => {
    const bad = { ...base, replication: { tables: ["documents"] } };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  test("requires at least one published table", () => {
    const bad = { ...base, replication: { tables: [] } };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects a non-identifier hash column (SQL-injection guard)", () => {
    const bad = {
      ...base,
      reconcile: { tables: [{ name: "public.documents", hashColumns: ['id"; drop'] }] },
    };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe("supabaseSourceRef", () => {
  test("returns the ref for a postgres source", () => {
    const cfg = ConfigSchema.parse(base);
    expect(supabaseSourceRef(cfg)).toBe("aaaaaaaaaaaaaaaaaaaa");
  });

  test("throws for a heterogeneous source (no Supabase project ref)", () => {
    const cfg = ConfigSchema.parse({
      ...base,
      source: { engine: "mysql", serverId: 1, databases: ["inventory"] },
      replication: { tables: ["inventory.customers"] },
      reconcile: { tables: [{ name: "inventory.customers" }] },
    });
    expect(() => supabaseSourceRef(cfg)).toThrow(/Supabase SOURCE project/);
  });
});

describe("SecretsSchema", () => {
  test("accepts direct connection urls and an sbp_ token", () => {
    const r = SecretsSchema.safeParse({
      SOURCE_DB_URL: "postgresql://postgres:pw@db.a.supabase.co:5432/postgres",
      TARGET_DB_URL: "postgresql://postgres:pw@db.b.supabase.co:5432/postgres",
      SUPABASE_ACCESS_TOKEN: "sbp_abc123",
    });
    expect(r.success).toBe(true);
  });

  test("rejects an access token without the sbp_ prefix", () => {
    const r = SecretsSchema.safeParse({
      SOURCE_DB_URL: "postgresql://x:y@h:5432/d",
      TARGET_DB_URL: "postgresql://x:y@h:5432/d",
      SUPABASE_ACCESS_TOKEN: "wrong",
    });
    expect(r.success).toBe(false);
  });
});

describe("parseEnvFile", () => {
  test("parses KEY=VALUE, ignores comments/blanks, strips quotes + export", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "SOURCE_DB_URL=postgresql://x:y@h:5432/d",
        'TARGET_DB_URL="postgresql://a:b@h:5432/d"',
        "export SUPABASE_ACCESS_TOKEN='sbp_tok'",
        "  # indented comment",
        "NOT A LINE",
        "=novalue",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      SOURCE_DB_URL: "postgresql://x:y@h:5432/d",
      TARGET_DB_URL: "postgresql://a:b@h:5432/d",
      SUPABASE_ACCESS_TOKEN: "sbp_tok",
    });
  });
});

describe("applyEnvFile", () => {
  test("overrides inherited env and reports only the keys whose value DIFFERED", () => {
    const dir = mkdtempSync(join(tmpdir(), "pgshift-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, "PGSHIFT_TEST_A=fromfile\nPGSHIFT_TEST_B=same\nPGSHIFT_TEST_C=new\n");
    process.env.PGSHIFT_TEST_A = "fromshell"; // conflict (differs)
    process.env.PGSHIFT_TEST_B = "same"; // present but identical -> not a conflict
    delete process.env.PGSHIFT_TEST_C; // absent -> not a conflict

    const { applied, conflicts } = applyEnvFile(path);

    expect(applied.sort()).toEqual(["PGSHIFT_TEST_A", "PGSHIFT_TEST_B", "PGSHIFT_TEST_C"]);
    expect(conflicts).toEqual(["PGSHIFT_TEST_A"]);
    expect(process.env.PGSHIFT_TEST_A).toBe("fromfile"); // file won
    for (const k of ["PGSHIFT_TEST_A", "PGSHIFT_TEST_B", "PGSHIFT_TEST_C"]) delete process.env[k];
  });
});
