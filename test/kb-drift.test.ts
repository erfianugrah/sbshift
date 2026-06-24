import { describe, expect, test } from "bun:test";
import { checks } from "../src/kb/checks.ts";
import { DEFAULT_MAX_AGE_DAYS, type DriftableItem, kbDrift } from "../src/kb/drift.ts";
import { providerHints } from "../src/kb/provider-hints.ts";

function item(id: string, lastSynced: string): DriftableItem {
  return { id, provenance: { source: `/docs/${id}.md`, lastSynced } };
}

describe("kbDrift", () => {
  const now = new Date("2026-06-24T12:00:00Z");

  test("age is whole days from lastSynced UTC midnight to now", () => {
    const r = kbDrift([item("a", "2026-06-14")], { now, maxAgeDays: 90 });
    expect(r.rows[0]?.ageDays).toBe(10);
  });

  test("same-day sync → age 0, not stale", () => {
    const r = kbDrift([item("a", "2026-06-24")], { now, maxAgeDays: 90 });
    expect(r.rows[0]).toMatchObject({ ageDays: 0, stale: false });
    expect(r.staleCount).toBe(0);
  });

  test("age >= threshold is stale (boundary inclusive)", () => {
    const at = kbDrift([item("a", "2026-03-26")], { now, maxAgeDays: 90 }); // exactly 90d
    expect(at.rows[0]?.ageDays).toBe(90);
    expect(at.rows[0]?.stale).toBe(true);
    const under = kbDrift([item("a", "2026-03-27")], { now, maxAgeDays: 90 }); // 89d
    expect(under.rows[0]?.stale).toBe(false);
  });

  test("rows sorted stalest-first; staleCount counts stale rows", () => {
    const r = kbDrift(
      [item("fresh", "2026-06-20"), item("old", "2026-01-01"), item("mid", "2026-05-01")],
      { now, maxAgeDays: 90 },
    );
    expect(r.rows.map((x) => x.id)).toEqual(["old", "mid", "fresh"]);
    expect(r.staleCount).toBe(1); // only "old" (>174d) exceeds 90d
  });

  test("report echoes the reference date + threshold", () => {
    const r = kbDrift([item("a", "2026-06-24")], { now, maxAgeDays: 30 });
    expect(r).toMatchObject({ now: "2026-06-24", maxAgeDays: 30 });
  });

  test("default threshold is the documented cadence", () => {
    const r = kbDrift([item("a", "2026-06-24")], { now });
    expect(r.maxAgeDays).toBe(DEFAULT_MAX_AGE_DAYS);
  });

  test("real catalog: nothing stale on its own sync date, all stale far in the future", () => {
    const synced = providerHints[0]?.provenance.lastSynced ?? "2026-06-24";
    const onDate = kbDrift(providerHints, { now: new Date(`${synced}T00:00:00Z`) });
    expect(onDate.staleCount).toBe(0);
    const future = kbDrift(providerHints, { now: new Date("2030-01-01T00:00:00Z") });
    expect(future.staleCount).toBe(providerHints.length);
  });

  test("drift spans BOTH catalogs — provider hints and live checks", () => {
    const combined = [...providerHints, ...checks];
    const r = kbDrift(combined, { now });
    expect(r.rows.length).toBe(combined.length);
    // every check id is represented, not just provider-hint ids
    const ids = new Set(r.rows.map((x) => x.id));
    for (const c of checks) expect(ids.has(c.id)).toBe(true);
  });
});
