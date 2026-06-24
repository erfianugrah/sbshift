import { describe, expect, test } from "bun:test";
import { buildGuide, guidableProviders } from "../src/kb/guide.ts";
import { providerHints } from "../src/kb/provider-hints.ts";

describe("guidableProviders", () => {
  test("lists exactly the providers with at least one item, deduped", () => {
    const providers = guidableProviders();
    expect(new Set(providers)).toEqual(
      new Set([
        "rds-postgres",
        "aurora-postgres",
        "planetscale-postgres",
        "neon",
        "azure-postgres",
      ]),
    );
    expect(providers.length).toBe(new Set(providers).size);
  });

  test("excludes supabase and generic (no items)", () => {
    expect(guidableProviders()).not.toContain("supabase");
    expect(guidableProviders()).not.toContain("generic");
  });
});

describe("buildGuide", () => {
  test("both roles for a provider that has source + target items, source first", () => {
    const g = buildGuide("neon");
    expect(g.sections.map((s) => s.role)).toEqual(["source", "target"]);
    expect(g.sections[0]?.phase).toBe("source-prep");
    expect(g.sections[1]?.phase).toBe("target-prep");
    expect(g.itemCount).toBe(2);
  });

  test("source-only provider yields a single source section", () => {
    const g = buildGuide("rds-postgres");
    expect(g.sections.map((s) => s.role)).toEqual(["source"]);
    expect(g.itemCount).toBe(1);
    expect(g.sections[0]?.items[0]?.id).toBe("rds-postgres.enable_logical_replication");
  });

  test("--role filter keeps only the requested role", () => {
    const src = buildGuide("planetscale-postgres", { role: "source" });
    expect(src.sections.map((s) => s.role)).toEqual(["source"]);
    const tgt = buildGuide("planetscale-postgres", { role: "target" });
    expect(tgt.sections.map((s) => s.role)).toEqual(["target"]);
  });

  test("role with no items yields an empty guide (no section)", () => {
    const g = buildGuide("rds-postgres", { role: "target" });
    expect(g.sections).toEqual([]);
    expect(g.itemCount).toBe(0);
  });

  test("a provider with no items at all is empty, not an error", () => {
    const g = buildGuide("supabase");
    expect(g.itemCount).toBe(0);
  });

  test("itemCount equals the sum of section items and matches the raw KB", () => {
    let total = 0;
    for (const p of guidableProviders()) total += buildGuide(p).itemCount;
    expect(total).toBe(providerHints.length);
  });
});
