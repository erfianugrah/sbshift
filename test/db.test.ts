import { describe, expect, test } from "bun:test";
import { isTransient, sourceConnUrl } from "../src/db.ts";

// C-2: sourceConnString (libpq keyword=value) was replaced by sourceConnUrl which
// returns the raw URL for CREATE SUBSCRIPTION CONNECTION — no quoting needed
// because Postgres accepts URL format natively and percent-encoding handles special chars.
describe("sourceConnUrl", () => {
  test("prefers SOURCE_REPLICATION_URL when set", () => {
    const url = sourceConnUrl({
      SOURCE_DB_URL: "postgresql://postgres:pw@pooler.host/db",
      TARGET_DB_URL: "postgresql://postgres:pw@target/db",
      SOURCE_REPLICATION_URL: "postgresql://postgres:pw@db.ref.supabase.co/postgres",
    });
    expect(url).toBe("postgresql://postgres:pw@db.ref.supabase.co/postgres");
  });

  test("falls back to SOURCE_DB_URL when SOURCE_REPLICATION_URL is absent", () => {
    const url = sourceConnUrl({
      SOURCE_DB_URL: "postgresql://postgres:pw123@db.aaaa.supabase.co:5432/postgres",
      TARGET_DB_URL: "postgresql://postgres:pw@db.bbbb.supabase.co:5432/postgres",
    });
    expect(url).toBe("postgresql://postgres:pw123@db.aaaa.supabase.co:5432/postgres");
  });

  test("a password with special characters stays percent-encoded (no quoting needed)", () => {
    const url = sourceConnUrl({
      SOURCE_DB_URL: "postgresql://postgres:p%40ss%3Aword@db.x.supabase.co/postgres",
      TARGET_DB_URL: "postgresql://u:p@t/db",
    });
    // Percent-encoded form is safe for SQL string embedding — no raw ' or spaces
    expect(url).toContain("p%40ss%3Aword");
    expect(url).not.toContain("p@ss:word");
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
