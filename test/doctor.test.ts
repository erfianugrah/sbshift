import { describe, expect, test } from "bun:test";
import { classifyConn } from "../src/db.ts";
import { diffHashColumns, externalDeps, type Fk } from "../src/steps/doctor.ts";

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
