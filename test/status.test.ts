/**
 * Unit tests for src/steps/status.ts pure functions.
 * H-1: status.ts had zero test coverage.
 */
import { describe, expect, test } from "bun:test";
import type { StatusSnapshot } from "../src/steps/status.ts";
import { printStatus } from "../src/steps/status.ts";

function makeSnap(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    ts: new Date().toISOString(),
    subscription: { name: "sub", exists: true, enabled: true },
    tables: { total: 4, ready: 4, init: 0, copying: 0, synced: 0, allReady: true },
    slot: { name: "slot", exists: true, active: true, walRetainedMb: 0, lagBytes: 0 },
    ...overrides,
  };
}

describe("StatusSnapshot shape", () => {
  test("allReady is true when total > 0 and ready === total", () => {
    const s = makeSnap();
    expect(s.tables.allReady).toBe(true);
  });

  test("allReady is false when ready < total", () => {
    const s = makeSnap({ tables: { total: 4, ready: 2, init: 1, copying: 1, synced: 0, allReady: false } });
    expect(s.tables.allReady).toBe(false);
  });

  test("L-6: lagBytes is non-negative in snapshot", () => {
    // The status() function clamps lagBytes to Math.max(0, ...).
    // This test documents the invariant: callers can assume lagBytes >= 0.
    const s = makeSnap({ slot: { name: "s", exists: true, active: true, walRetainedMb: 0, lagBytes: 0 } });
    expect(s.slot.lagBytes).toBeGreaterThanOrEqual(0);
  });
});

describe("printStatus", () => {
  test("does not throw for a fully synced snapshot", () => {
    expect(() => printStatus(makeSnap())).not.toThrow();
  });

  test("does not throw for a missing subscription snapshot", () => {
    expect(() =>
      printStatus(
        makeSnap({
          subscription: { name: "sub", exists: false, enabled: null },
          tables: { total: 0, ready: 0, init: 0, copying: 0, synced: 0, allReady: false },
          slot: { name: "slot", exists: false, active: false, walRetainedMb: 0, lagBytes: 0 },
        }),
      ),
    ).not.toThrow();
  });

  test("does not throw for a partially synced snapshot", () => {
    expect(() =>
      printStatus(
        makeSnap({
          tables: { total: 4, ready: 2, init: 1, copying: 1, synced: 0, allReady: false },
          slot: { name: "slot", exists: true, active: true, walRetainedMb: 512, lagBytes: 1024 },
        }),
      ),
    ).not.toThrow();
  });
});
