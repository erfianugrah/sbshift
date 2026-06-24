import { describe, expect, mock, test } from "bun:test";
import * as cutoverMod from "../src/steps/cutover.ts";
import * as reconcileMod from "../src/steps/reconcile.ts";
import * as replicateMod from "../src/steps/replicate.ts";
import * as teardownMod from "../src/steps/teardown.ts";
import * as watchMod from "../src/steps/watch.ts";

// Stub the five step functions BEFORE importing the engine, so delegation is asserted without
// touching a live database. mock.module replaces the WHOLE module process-wide, so spread the
// real exports and override only the one function — otherwise sibling exports (e.g.
// reconcile.ts's classifyRows) vanish and unrelated test files break.
const calls: Record<string, unknown[]> = {};
const spy = (name: string, ret: unknown) =>
  mock((...args: unknown[]) => {
    calls[name] = args;
    return ret;
  });

mock.module("../src/steps/replicate.ts", () => ({
  ...replicateMod,
  replicate: spy("replicate", Promise.resolve()),
}));
mock.module("../src/steps/watch.ts", () => ({
  ...watchMod,
  watch: spy("watch", Promise.resolve()),
}));
mock.module("../src/steps/reconcile.ts", () => ({
  ...reconcileMod,
  reconcile: spy("reconcile", Promise.resolve(true)),
}));
mock.module("../src/steps/cutover.ts", () => ({
  ...cutoverMod,
  cutover: spy("cutover", Promise.resolve()),
}));
mock.module("../src/steps/teardown.ts", () => ({
  ...teardownMod,
  teardown: spy("teardown", Promise.resolve()),
}));

const { NativePgEngine } = await import("../src/engine/native-pg.ts");
const { engineFor } = await import("../src/engine/index.ts");

// Opaque sentinels — the engine only forwards them, never inspects them.
// biome-ignore lint/suspicious/noExplicitAny: test sentinels for forwarded args
const src = { s: 1 } as any;
// biome-ignore lint/suspicious/noExplicitAny: test sentinels for forwarded args
const tgt = { t: 1 } as any;
// biome-ignore lint/suspicious/noExplicitAny: test sentinels for forwarded args
const cfg = { c: 1 } as any;
// biome-ignore lint/suspicious/noExplicitAny: test sentinels for forwarded args
const secrets = { k: 1 } as any;

describe("NativePgEngine", () => {
  const engine = new NativePgEngine();

  test("kind is native-pg", () => {
    expect(engine.kind).toBe("native-pg");
  });

  test("replicate delegates with (source, target, cfg, secrets)", async () => {
    await engine.replicate(src, tgt, cfg, secrets);
    expect(calls.replicate).toEqual([src, tgt, cfg, secrets]);
  });

  test("watch delegates with (source, target, cfg)", async () => {
    await engine.watch(src, tgt, cfg);
    expect(calls.watch).toEqual([src, tgt, cfg]);
  });

  test("reconcile forwards opts and returns the underlying boolean", async () => {
    const ok = await engine.reconcile(src, tgt, cfg, { mode: "full" });
    expect(calls.reconcile).toEqual([src, tgt, cfg, { mode: "full" }]);
    expect(ok).toBe(true);
  });

  test("reconcile defaults opts to {} when omitted", async () => {
    await engine.reconcile(src, tgt, cfg);
    expect(calls.reconcile).toEqual([src, tgt, cfg, {}]);
  });

  test("cutover delegates with its opts", async () => {
    await engine.cutover(src, tgt, cfg, { maxLagWaitSec: 120 });
    expect(calls.cutover).toEqual([src, tgt, cfg, { maxLagWaitSec: 120 }]);
  });

  test("teardown delegates with (source, target, cfg)", async () => {
    await engine.teardown(src, tgt, cfg);
    expect(calls.teardown).toEqual([src, tgt, cfg]);
  });
});

describe("engineFor", () => {
  test("returns the native-pg engine today (the only impl)", () => {
    expect(engineFor(cfg).kind).toBe("native-pg");
  });

  test("returns a fresh instance per call (stateless)", () => {
    expect(engineFor(cfg)).not.toBe(engineFor(cfg));
  });
});
