import { describe, expect, test } from "bun:test";
import type { ClaimPreview } from "../src/mgmt.ts";
import { evaluateClaimPreview } from "../src/steps/claim.ts";

const preview = (over: Partial<ClaimPreview> = {}): ClaimPreview => ({
  valid: true,
  warnings: [],
  errors: [],
  info: [],
  members_exceeding_free_project_limit: [],
  source_subscription_plan: "pro",
  target_subscription_plan: "pro",
  ...over,
});

const NOW = Date.parse("2026-06-19T00:00:00Z");

describe("evaluateClaimPreview — gate", () => {
  test("clean same-plan preview passes", () => {
    const v = evaluateClaimPreview(preview());
    expect(v).toEqual({ ok: true, blockers: [], warnings: [] });
  });

  test("API errors are hard blockers", () => {
    const v = evaluateClaimPreview(preview({ errors: [{ key: "x", message: "nope" }] }));
    expect(v.ok).toBe(false);
    expect(v.blockers[0]).toContain("nope");
  });

  test("valid=false blocks even with no error rows (fail closed)", () => {
    const v = evaluateClaimPreview(preview({ valid: false }));
    expect(v.ok).toBe(false);
    expect(v.blockers).toHaveLength(1);
  });

  test("expired token blocks", () => {
    const v = evaluateClaimPreview(preview(), {
      expiresAt: "2026-06-18T00:00:00Z",
      now: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.blockers[0]).toContain("expired");
  });

  test("unexpired token does not block", () => {
    const v = evaluateClaimPreview(preview(), {
      expiresAt: "2026-06-20T00:00:00Z",
      now: NOW,
    });
    expect(v.ok).toBe(true);
  });

  test("plan downgrade warns but does NOT block", () => {
    const v = evaluateClaimPreview(
      preview({ source_subscription_plan: "team", target_subscription_plan: "free" }),
    );
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes("DOWNGRADE"))).toBe(true);
  });

  test("plan upgrade is silent", () => {
    const v = evaluateClaimPreview(
      preview({ source_subscription_plan: "free", target_subscription_plan: "pro" }),
    );
    expect(v.warnings).toHaveLength(0);
  });

  test("members over free limit warn but do not block", () => {
    const v = evaluateClaimPreview(
      preview({ members_exceeding_free_project_limit: [{ name: "alice", limit: 2 }] }),
    );
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes("alice"))).toBe(true);
  });

  test("blockers + warnings coexist; ok follows blockers only", () => {
    const v = evaluateClaimPreview(
      preview({
        valid: false,
        source_subscription_plan: "team",
        target_subscription_plan: "free",
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.warnings.length).toBeGreaterThan(0);
  });
});
