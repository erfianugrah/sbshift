import { describe, expect, test } from "bun:test";
import { ConfigSchema, SecretsSchema } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { phasesThrough, run } from "../src/steps/run.ts";

describe("phasesThrough", () => {
  test("default reconcile range excludes cutover", () => {
    expect(phasesThrough("reconcile")).toEqual(["preflight", "replicate", "watch", "reconcile"]);
  });

  test("watch range stops at watch", () => {
    expect(phasesThrough("watch")).toEqual(["preflight", "replicate", "watch"]);
  });

  test("replicate range", () => {
    expect(phasesThrough("replicate")).toEqual(["preflight", "replicate"]);
  });

  test("cutover range is the full pipeline", () => {
    expect(phasesThrough("cutover")).toEqual([
      "preflight",
      "replicate",
      "watch",
      "reconcile",
      "cutover",
    ]);
  });

  test("preflight alone", () => {
    expect(phasesThrough("preflight")).toEqual(["preflight"]);
  });

  test("unknown phase throws", () => {
    // @ts-expect-error testing the runtime guard with an invalid phase
    expect(() => phasesThrough("bogus")).toThrow();
  });
});

// M-9: the confirmWritesStopped safety gate must be enforced before any DB
// operation runs, so dummy (never-called) Db objects are sufficient here.
describe("run: confirmWritesStopped guard", () => {
  const dummy = {} as Db;
  const cfg = ConfigSchema.parse({
    source: { ref: "a".repeat(20) },
    target: { ref: "b".repeat(20) },
    replication: { tables: ["public.t"], publication: "p", slot: "s", subscription: "sub" },
    reconcile: { tables: [{ name: "public.t" }] },
    watchdog: { maxRetainedWalMb: 1000, pollIntervalSec: 1, syncTimeoutMin: 1 },
  });
  const secrets = SecretsSchema.parse({
    SOURCE_DB_URL: "postgresql://u:p@localhost/db",
    TARGET_DB_URL: "postgresql://u:p@localhost/db",
  });

  test("through=cutover without confirmWritesStopped throws before any DB call", async () => {
    await expect(run(dummy, dummy, cfg, secrets, { through: "cutover" })).rejects.toThrow(
      "confirmWritesStopped",
    );
  });

  test("through=cutover with confirmWritesStopped passes the guard and proceeds to preflight", async () => {
    // run() catches phase errors and returns { ok: false } rather than rejecting.
    // When the guard passes, it attempts preflight on the dummy DB, which fails
    // with a DB error — not the guard error.
    const result = await run(dummy, dummy, cfg, secrets, {
      through: "cutover",
      confirmWritesStopped: true,
    });
    expect(result.ok).toBe(false);
    // First failing phase must be preflight, not the guard
    const firstError = result.phases[0]?.error ?? "";
    expect(firstError).not.toContain("confirmWritesStopped");
  });
});
