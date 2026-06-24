import { describe, expect, test } from "bun:test";
import { classifyConn } from "../src/db.ts";
import { diffHashColumns, externalDeps, type Fk, providerHint } from "../src/steps/doctor.ts";

describe("classifyConn", () => {
  test("direct Supabase host → ref extracted, not pooler", () => {
    const c = classifyConn(
      "postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres",
    );
    expect(c).toMatchObject({
      isPooler: false,
      isSupabaseDirect: true,
      ref: "abcdefghijklmnop",
      port: 5432,
    });
  });

  test("pooler host → isPooler, not direct", () => {
    const c = classifyConn(
      "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
    );
    expect(c.isPooler).toBe(true);
    expect(c.isSupabaseDirect).toBe(false);
    expect(c.ref).toBeUndefined();
  });

  test("session pooler (5432) is NOT a transaction pooler — dumps are fine", () => {
    const c = classifyConn(
      "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
    );
    expect(c.isPooler).toBe(true);
    expect(c.isTransactionPooler).toBe(false);
  });

  test("transaction pooler (6543) flagged — pg_dump would break over it", () => {
    const c = classifyConn(
      "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres",
    );
    expect(c.isPooler).toBe(true);
    expect(c.isTransactionPooler).toBe(true);
  });

  test("defaults port to 5432 when absent", () => {
    expect(classifyConn("postgresql://u:p@localhost/postgres").port).toBe(5432);
  });

  test("plain host is neither pooler nor direct", () => {
    const c = classifyConn("postgresql://u:p@source:5432/postgres");
    expect(c.isPooler).toBe(false);
    expect(c.isSupabaseDirect).toBe(false);
  });
});

describe("classifyConn — provider detection", () => {
  test("Supabase direct host → provider supabase", () => {
    expect(
      classifyConn("postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres")
        .provider,
    ).toBe("supabase");
  });

  test("Supabase pooler host → provider supabase", () => {
    expect(
      classifyConn(
        "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
      ).provider,
    ).toBe("supabase");
  });

  test("RDS PostgreSQL instance host → provider rds-postgres", () => {
    expect(
      classifyConn("postgresql://u:pw@mydb.abc123xyz.eu-west-1.rds.amazonaws.com:5432/postgres")
        .provider,
    ).toBe("rds-postgres");
  });

  test("Aurora cluster endpoint → provider aurora-postgres (not plain rds)", () => {
    const writer = classifyConn(
      "postgresql://u:pw@mycluster.cluster-abc123.eu-west-1.rds.amazonaws.com:5432/postgres",
    );
    expect(writer.provider).toBe("aurora-postgres");
    const reader = classifyConn(
      "postgresql://u:pw@mycluster.cluster-ro-abc123.eu-west-1.rds.amazonaws.com:5432/postgres",
    );
    expect(reader.provider).toBe("aurora-postgres");
  });

  test("Neon host → provider neon", () => {
    expect(
      classifyConn("postgresql://u:pw@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb")
        .provider,
    ).toBe("neon");
    expect(
      classifyConn(
        "postgresql://u:pw@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb",
      ).provider,
    ).toBe("neon");
  });

  test("PlanetScale Postgres host → provider planetscale-postgres", () => {
    expect(
      classifyConn("postgresql://postgres.br123:pw@abcd-useast1-1.horizon.psdb.cloud:5432/db")
        .provider,
    ).toBe("planetscale-postgres");
    expect(
      classifyConn(
        "postgresql://postgres.br123:pw@ps-main.gcp-us-central1-1.private-pg.psdb.cloud:5432/db",
      ).provider,
    ).toBe("planetscale-postgres");
  });

  test("Azure Database for PostgreSQL host → provider azure-postgres", () => {
    expect(
      classifyConn("postgresql://u:pw@myserver.postgres.database.azure.com:5432/postgres").provider,
    ).toBe("azure-postgres");
  });

  test("unknown host → provider generic", () => {
    expect(classifyConn("postgresql://u:p@localhost:5432/postgres").provider).toBe("generic");
    expect(classifyConn("postgresql://u:p@source:5432/postgres").provider).toBe("generic");
  });
});

describe("providerHint", () => {
  test("RDS source → mentions custom parameter group + reboot", () => {
    const h = providerHint("rds-postgres", "source");
    expect(h).toContain("rds.logical_replication=1");
    expect(h).toMatch(/REBOOT/i);
  });

  test("Aurora source → mentions cluster parameter group + enhanced slot caveat", () => {
    const h = providerHint("aurora-postgres", "source");
    expect(h).toMatch(/CLUSTER parameter group/i);
    expect(h).toMatch(/INVALIDATES/i);
  });

  test("Neon source → warns irreversible + 40h slot reaping", () => {
    const h = providerHint("neon", "source");
    expect(h).toMatch(/IRREVERSIBLE/i);
    expect(h).toContain("40h");
  });

  test("Neon target → warns scale-to-zero", () => {
    expect(providerHint("neon", "target")).toMatch(/scale to zero/i);
  });

  test("PlanetScale source → warns port 6432 PgBouncer can't stream WAL", () => {
    const h = providerHint("planetscale-postgres", "source");
    expect(h).toContain("5432");
    expect(h).toMatch(/6432 is PgBouncer/i);
  });

  test("PlanetScale target → warns 150% disk + copy_data=false", () => {
    const h = providerHint("planetscale-postgres", "target");
    expect(h).toMatch(/150%/);
    expect(h).toContain("copy_data=false");
  });

  test("Azure source → mentions wal_level=logical + failover slots", () => {
    const h = providerHint("azure-postgres", "source");
    expect(h).toContain("wal_level=logical");
    expect(h).toMatch(/PG Failover Slots/i);
  });

  test("supabase + generic → no hint (handled elsewhere / generic check suffices)", () => {
    expect(providerHint("supabase", "source")).toBeNull();
    expect(providerHint("generic", "source")).toBeNull();
  });

  test("providers without a target-specific note return null for target role", () => {
    expect(providerHint("rds-postgres", "target")).toBeNull();
    expect(providerHint("aurora-postgres", "target")).toBeNull();
    expect(providerHint("azure-postgres", "target")).toBeNull();
  });
});

describe("externalDeps", () => {
  const replicated = ["public.documents", "public.aliases"];
  const fks: Fk[] = [
    { table: "public.documents", references: "auth.users" },
    { table: "public.aliases", references: "public.documents" },
  ];

  test("flags FK into a non-replicated schema (auth.users)", () => {
    expect(externalDeps(fks, replicated)).toEqual(["auth.users"]);
  });

  test("intra-set FK (aliases→documents) is not an external dep", () => {
    expect(
      externalDeps([{ table: "public.aliases", references: "public.documents" }], replicated),
    ).toEqual([]);
  });

  test("ignores FKs on tables we don't replicate", () => {
    expect(externalDeps([{ table: "other.thing", references: "auth.users" }], replicated)).toEqual(
      [],
    );
  });

  test("dedups + sorts multiple external refs", () => {
    const many: Fk[] = [
      { table: "public.documents", references: "auth.users" },
      { table: "public.aliases", references: "auth.users" },
      { table: "public.documents", references: "storage.objects" },
    ];
    expect(externalDeps(many, replicated)).toEqual(["auth.users", "storage.objects"]);
  });
});

describe("diffHashColumns", () => {
  const live = ["id", "content", "title"];
  const gen = ["search_vector"];

  test("undefined pinned (auto-detect) → no findings", () => {
    expect(diffHashColumns(undefined, live, gen)).toEqual({
      missingFromPinned: [],
      nonexistent: [],
      generatedPinned: [],
    });
  });

  test("pinned exactly matches live non-generated → clean", () => {
    expect(diffHashColumns(["id", "content", "title"], live, gen)).toEqual({
      missingFromPinned: [],
      nonexistent: [],
      generatedPinned: [],
    });
  });

  test("live column omitted from pinned → missingFromPinned (silent-skip risk)", () => {
    expect(diffHashColumns(["id", "content"], live, gen).missingFromPinned).toEqual(["title"]);
  });

  test("pinned column not on table → nonexistent (reconcile SQL error)", () => {
    expect(diffHashColumns(["id", "content", "title", "bogus"], live, gen).nonexistent).toEqual([
      "bogus",
    ]);
  });

  test("pinned a generated column → generatedPinned (false mismatch)", () => {
    expect(
      diffHashColumns(["id", "content", "title", "search_vector"], live, gen).generatedPinned,
    ).toEqual(["search_vector"]);
  });

  test("a generated column counts as existing, not nonexistent", () => {
    const d = diffHashColumns(["id", "content", "title", "search_vector"], live, gen);
    expect(d.nonexistent).toEqual([]);
  });
});
