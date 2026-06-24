import { describe, expect, test } from "bun:test";
import { check, checks, type QueryFn, runCheck } from "../src/kb/checks.ts";
import { Checks } from "../src/kb/schema.ts";

const walLevel = check("source.wal_level_logical");

/** A QueryFn that ignores the SQL and returns canned rows. */
const rows =
  (...r: Record<string, unknown>[]): QueryFn =>
  async () =>
    r;

describe("checks catalog", () => {
  test("parses against the schema", () => {
    expect(() => Checks.parse(checks)).not.toThrow();
  });

  test("ids are unique", () => {
    const ids = checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every check carries a provenance source + ISO-dated lastSynced", () => {
    for (const c of checks) {
      expect(c.provenance.source).toMatch(/^(\/docs\/|https?:\/\/)/);
      expect(c.provenance.lastSynced).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("check() returns a known item and throws on an unknown id", () => {
    expect(check("source.wal_level_logical").id).toBe("source.wal_level_logical");
    expect(() => check("nope.missing")).toThrow(/unknown check id/);
  });

  test("wal_level check has the expected probe shape", () => {
    expect(walLevel).toMatchObject({
      phase: "source-prep",
      severity: "fail",
      expect: "logical",
      detect: { sql: "SHOW wal_level", column: "wal_level" },
    });
  });
});

describe("runCheck", () => {
  test("observed equals expect → ok", async () => {
    const r = await runCheck(rows({ wal_level: "logical" }), walLevel);
    expect(r).toEqual({
      id: "source.wal_level_logical",
      present: true,
      observed: "logical",
      ok: true,
    });
  });

  test("observed differs → not ok, observed carried through for the message", async () => {
    const r = await runCheck(rows({ wal_level: "replica" }), walLevel);
    expect(r).toEqual({
      id: "source.wal_level_logical",
      present: true,
      observed: "replica",
      ok: false,
    });
  });

  test("non-string observed is stringified before comparison", async () => {
    const r = await runCheck(rows({ wal_level: 1 }), {
      ...walLevel,
      expect: "1",
    });
    expect(r.observed).toBe("1");
    expect(r.ok).toBe(true);
  });

  test("empty result set → observed null, not ok", async () => {
    const r = await runCheck(rows(), walLevel);
    expect(r).toEqual({
      id: "source.wal_level_logical",
      present: false,
      observed: null,
      ok: false,
    });
  });

  test("reads the named column, ignoring others in the row", async () => {
    const r = await runCheck(rows({ other: "x", wal_level: "logical" }), walLevel);
    expect(r.ok).toBe(true);
  });
});

describe("runCheck — existence checks (no expect/column)", () => {
  const slot = check("source.slot_absent");

  test("a returned row → present, ok falls back to present", async () => {
    const r = await runCheck(rows({ "?column?": 1 }), slot, ["my_slot"]);
    expect(r).toEqual({ id: "source.slot_absent", present: true, observed: null, ok: true });
  });

  test("no row → not present", async () => {
    const r = await runCheck(rows(), slot, ["my_slot"]);
    expect(r).toEqual({ id: "source.slot_absent", present: false, observed: null, ok: false });
  });

  test("params are forwarded to the query verbatim", async () => {
    let seen: readonly unknown[] | undefined;
    const spy: QueryFn = async (_sql, p) => {
      seen = p;
      return [];
    };
    await runCheck(spy, slot, ["region_migration_slot"]);
    expect(seen).toEqual(["region_migration_slot"]);
  });

  test("existence checks carry no column or expect in the catalog", () => {
    for (const id of ["source.slot_absent", "source.publication_absent"]) {
      const c = check(id);
      expect(c.detect.column).toBeUndefined();
      expect(c.expect).toBeUndefined();
      expect(c.detect.sql).toContain("$1");
    }
  });
});
