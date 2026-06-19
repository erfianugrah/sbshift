import { describe, expect, test } from "bun:test";
import { ConfigSchema, SecretsSchema } from "../src/config.ts";

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
  });

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
