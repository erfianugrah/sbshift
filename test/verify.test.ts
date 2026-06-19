import { describe, expect, test } from "bun:test";
import type { Lint } from "../src/mgmt.ts";
import { dedupeSortLints, summarizeLints } from "../src/steps/verify.ts";

const lint = (over: Partial<Lint>): Lint => ({
  name: "rls_disabled_in_public",
  title: "RLS disabled",
  level: "ERROR",
  ...over,
});

describe("summarizeLints — gate verdict", () => {
  const lints: Lint[] = [
    lint({
      name: "rls_disabled_in_public",
      level: "ERROR",
      metadata: { schema: "public", name: "users" },
    }),
    lint({
      name: "no_primary_key",
      level: "ERROR",
      metadata: { schema: "public", name: "events" },
    }),
    lint({
      name: "unindexed_foreign_keys",
      level: "WARN",
      metadata: { schema: "public", name: "orders" },
    }),
    lint({ name: "unused_index", level: "INFO", metadata: { schema: "public", name: "logs" } }),
  ];

  test("counts by level", () => {
    const s = summarizeLints(lints, "error");
    expect(s.total).toBe(4);
    expect(s.byLevel).toEqual({ ERROR: 2, WARN: 1, INFO: 0 + 1 });
  });

  test("fail-on=error gates only ERROR lints", () => {
    expect(summarizeLints(lints, "error").gating).toBe(2);
  });

  test("fail-on=warn gates ERROR + WARN", () => {
    expect(summarizeLints(lints, "warn").gating).toBe(3);
  });

  test("fail-on=info gates everything", () => {
    expect(summarizeLints(lints, "info").gating).toBe(4);
  });

  test("clean target passes", () => {
    expect(summarizeLints([], "error")).toEqual({
      total: 0,
      byLevel: { ERROR: 0, WARN: 0, INFO: 0 },
      gating: 0,
    });
  });
});

describe("dedupe — security + performance overlap", () => {
  test("same name+entity counted once", () => {
    // Supabase returns the same lint from both advisor endpoints; must not double-count.
    const dup: Lint[] = [
      lint({ name: "auth_users_exposed", metadata: { schema: "public", name: "v_users" } }),
      lint({ name: "auth_users_exposed", metadata: { schema: "public", name: "v_users" } }),
    ];
    expect(summarizeLints(dup, "error").gating).toBe(1);
    expect(dedupeSortLints(dup)).toHaveLength(1);
  });

  test("same name DIFFERENT entity kept separate", () => {
    const two: Lint[] = [
      lint({ name: "rls_disabled_in_public", metadata: { schema: "public", name: "a" } }),
      lint({ name: "rls_disabled_in_public", metadata: { schema: "public", name: "b" } }),
    ];
    expect(dedupeSortLints(two)).toHaveLength(2);
  });

  test("sorts ERROR before WARN before INFO", () => {
    const mixed: Lint[] = [
      lint({ name: "i", level: "INFO", metadata: { name: "i" } }),
      lint({ name: "e", level: "ERROR", metadata: { name: "e" } }),
      lint({ name: "w", level: "WARN", metadata: { name: "w" } }),
    ];
    expect(dedupeSortLints(mixed).map((l) => l.level)).toEqual(["ERROR", "WARN", "INFO"]);
  });
});
