import { describe, expect, test } from "bun:test";
import { isTransient, sourceConnString } from "../src/db.ts";

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

describe("isTransient — only connection-shaped errors are retryable", () => {
  test("connection-error messages are transient", () => {
    expect(isTransient(new Error("write CONNECTION_CLOSED"))).toBe(true);
    expect(isTransient(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransient(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransient(new Error("connect ETIMEDOUT 1.2.3.4:5432"))).toBe(true);
    expect(isTransient(new Error("write EPIPE"))).toBe(true);
  });

  test("connection-exception + admin-shutdown SQLSTATEs are transient", () => {
    expect(isTransient(Object.assign(new Error("server closed"), { code: "08006" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("conn failure"), { code: "08000" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("admin shutdown"), { code: "57P01" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("crash shutdown"), { code: "57P02" }))).toBe(true);
  });

  test("SQL errors are NOT transient (would just fail again)", () => {
    expect(isTransient(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(false);
    expect(isTransient(Object.assign(new Error("unique violation"), { code: "23505" }))).toBe(
      false,
    );
    expect(isTransient(Object.assign(new Error("undefined table"), { code: "42P01" }))).toBe(false);
  });

  test("plain errors / non-errors are NOT transient", () => {
    expect(isTransient(new Error("boom"))).toBe(false);
    expect(isTransient("some string")).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});
