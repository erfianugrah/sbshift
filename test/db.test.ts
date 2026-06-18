import { describe, expect, test } from "bun:test";
import { sourceConnString } from "../src/db.ts";

describe("sourceConnString", () => {
  test("builds a libpq connection string from a direct URL", () => {
    const s = sourceConnString({
      SOURCE_DB_URL: "postgresql://postgres:pw123@db.aaaa.supabase.co:5432/postgres",
      TARGET_DB_URL: "postgresql://postgres:pw@db.bbbb.supabase.co:5432/postgres",
    });
    expect(s).toContain("host=db.aaaa.supabase.co");
    expect(s).toContain("port=5432");
    expect(s).toContain("user=postgres");
    expect(s).toContain("password=pw123");
    expect(s).toContain("dbname=postgres");
    expect(s).toContain("sslmode=require");
  });

  test("url-decodes a password with special characters", () => {
    const s = sourceConnString({
      SOURCE_DB_URL: "postgresql://postgres:p%40ss%3Aword@db.x.supabase.co:5432/postgres",
      TARGET_DB_URL: "postgresql://postgres:pw@db.y.supabase.co:5432/postgres",
    });
    expect(s).toContain("password=p@ss:word");
  });

  test("defaults port + dbname when absent", () => {
    const s = sourceConnString({
      SOURCE_DB_URL: "postgresql://u:p@host.example/",
      TARGET_DB_URL: "postgresql://u:p@host.example/",
    });
    expect(s).toContain("port=5432");
    expect(s).toContain("dbname=postgres");
  });
});
