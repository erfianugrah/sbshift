import { describe, expect, test } from "bun:test";
import { COMPUTE_TUNED, diffGucOverrides, parseRoleSettings } from "../src/steps/checks.ts";

describe("parseRoleSettings — pg_db_role_setting rows → flat overrides", () => {
  test("splits key=value, scopes by role@db", () => {
    const out = parseRoleSettings([
      {
        rolname: "postgres",
        datname: "postgres",
        setconfig: ["statement_timeout=60s", "work_mem=64MB"],
      },
      { rolname: "authenticator", datname: null, setconfig: ["pgrst.db_aggregates_enabled=true"] },
      { rolname: null, datname: "postgres", setconfig: ["auto_explain.log_min_duration=500ms"] },
    ]);
    expect(out).toEqual([
      { scope: "postgres@postgres", key: "statement_timeout", value: "60s" },
      { scope: "postgres@postgres", key: "work_mem", value: "64MB" },
      { scope: "authenticator@*", key: "pgrst.db_aggregates_enabled", value: "true" },
      { scope: "*@postgres", key: "auto_explain.log_min_duration", value: "500ms" },
    ]);
  });

  test("handles values containing '=' (splits on first only)", () => {
    const out = parseRoleSettings([
      { rolname: "postgres", datname: "postgres", setconfig: ["search_path=a=b"] },
    ]);
    expect(out[0]).toEqual({ scope: "postgres@postgres", key: "search_path", value: "a=b" });
  });

  test("tolerates null/empty setconfig and malformed entries", () => {
    expect(parseRoleSettings([{ rolname: "x", datname: "y", setconfig: null }])).toEqual([]);
    expect(parseRoleSettings([{ rolname: "x", datname: "y", setconfig: ["noequalsign"] }])).toEqual(
      [],
    );
  });
});

describe("diffGucOverrides — source vs target", () => {
  const src = parseRoleSettings([
    {
      rolname: "postgres",
      datname: "postgres",
      setconfig: ["statement_timeout=60s", "work_mem=64MB", "shared_buffers=8GB"],
    },
  ]);

  test("identical → no diff", () => {
    expect(diffGucOverrides(src, src)).toEqual({ sourceOnly: [], changed: [] });
  });

  test("missing on target → sourceOnly", () => {
    const tgt = parseRoleSettings([
      { rolname: "postgres", datname: "postgres", setconfig: ["statement_timeout=60s"] },
    ]);
    const d = diffGucOverrides(src, tgt);
    expect(d.sourceOnly.map((o) => o.key).sort()).toEqual(["shared_buffers", "work_mem"]);
    expect(d.changed).toEqual([]);
  });

  test("different value → changed (source + target reported)", () => {
    const tgt = parseRoleSettings([
      {
        rolname: "postgres",
        datname: "postgres",
        setconfig: ["statement_timeout=30s", "work_mem=64MB", "shared_buffers=1GB"],
      },
    ]);
    const d = diffGucOverrides(src, tgt);
    expect(d.sourceOnly).toEqual([]);
    expect(d.changed).toContainEqual({
      scope: "postgres@postgres",
      key: "statement_timeout",
      source: "60s",
      target: "30s",
    });
    expect(d.changed).toContainEqual({
      scope: "postgres@postgres",
      key: "shared_buffers",
      source: "8GB",
      target: "1GB",
    });
  });
});

describe("COMPUTE_TUNED — flags settings tied to instance size", () => {
  test("includes the memory/worker knobs that must not be blindly copied", () => {
    for (const k of ["shared_buffers", "work_mem", "max_connections", "effective_cache_size"]) {
      expect(COMPUTE_TUNED.has(k)).toBe(true);
    }
  });
  test("does NOT flag behavioural settings like statement_timeout", () => {
    expect(COMPUTE_TUNED.has("statement_timeout")).toBe(false);
    expect(COMPUTE_TUNED.has("auto_explain.log_min_duration")).toBe(false);
  });
});
