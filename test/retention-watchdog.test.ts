import { describe, expect, test } from "bun:test";
import { evaluateRetentionHeadroom, type RetentionVerdict } from "../src/engine/debezium.ts";

const evalAt = (elapsedSec: number, retentionSec: number | null, warnFraction = 0.8) =>
  evaluateRetentionHeadroom({
    elapsedSec,
    retentionSec,
    warnFraction,
    engineLabel: "CDC cleanup retention",
  });

describe("evaluateRetentionHeadroom (Debezium retention watchdog)", () => {
  test("unbounded/unknown retention no-ops (null)", () => {
    expect(evalAt(999_999, null)).toEqual({ level: "ok" });
  });

  test("non-positive retention no-ops (mysql binlog_expire=0 => unbounded)", () => {
    expect(evalAt(999_999, 0)).toEqual({ level: "ok" });
    expect(evalAt(999_999, -1)).toEqual({ level: "ok" });
  });

  test("well within the window is ok", () => {
    // 10min elapsed of a 3-day (default SQL Server) window
    expect(evalAt(600, 3 * 24 * 3600)).toEqual({ level: "ok" });
  });

  test("just below the warn fraction stays ok", () => {
    // 79% of a 100min window, warn at 80%
    expect(evalAt(0.79 * 6000, 6000).level).toBe("ok");
  });

  test("at/above the warn fraction warns (not abort)", () => {
    const v = evalAt(0.8 * 6000, 6000);
    expect(v.level).toBe("warn");
    expect((v as Extract<RetentionVerdict, { level: "warn" }>).message).toContain(
      "CDC cleanup retention",
    );
    expect((v as Extract<RetentionVerdict, { level: "warn" }>).message).toContain("80%");
  });

  test("at the full window aborts", () => {
    const v = evalAt(6000, 6000);
    expect(v.level).toBe("abort");
    expect((v as Extract<RetentionVerdict, { level: "abort" }>).message).toContain(
      "silent data loss",
    );
  });

  test("past the full window aborts", () => {
    expect(evalAt(12_000, 6000).level).toBe("abort");
  });

  test("warnFraction is honoured (custom 0.5)", () => {
    expect(evalAt(0.49 * 6000, 6000, 0.5).level).toBe("ok");
    expect(evalAt(0.5 * 6000, 6000, 0.5).level).toBe("warn");
  });

  test("engineLabel is threaded into messages (mysql binlog expiry)", () => {
    const v = evaluateRetentionHeadroom({
      elapsedSec: 6000,
      retentionSec: 6000,
      warnFraction: 0.8,
      engineLabel: "binlog expiry",
    });
    expect((v as Extract<RetentionVerdict, { level: "abort" }>).message).toContain("binlog expiry");
  });
});
