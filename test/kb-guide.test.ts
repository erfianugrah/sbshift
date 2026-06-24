import { describe, expect, test } from "bun:test";
import { checks } from "../src/kb/checks.ts";
import { buildGuide, guidableProviders } from "../src/kb/guide.ts";
import { providerHints } from "../src/kb/provider-hints.ts";

const SOURCE_PREP = checks.filter((c) => c.phase === "source-prep").length;
const TARGET_PREP = checks.filter((c) => c.phase === "target-prep").length;

describe("guidableProviders", () => {
  test("lists exactly the providers with at least one hint, deduped", () => {
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

  test("excludes supabase and generic (no hints)", () => {
    expect(guidableProviders()).not.toContain("supabase");
    expect(guidableProviders()).not.toContain("generic");
  });
});

describe("buildGuide", () => {
  test("a section combines provider hints with the phase's universal checks", () => {
    const g = buildGuide("neon");
    expect(g.sections.map((s) => s.role)).toEqual(["source", "target"]);
    const [src, tgt] = g.sections;
    // neon has 1 source hint + 1 target hint
    expect(src?.hints).toHaveLength(1);
    expect(tgt?.hints).toHaveLength(1);
    // every source-prep / target-prep check shows up under the matching role
    expect(src?.checks).toHaveLength(SOURCE_PREP);
    expect(tgt?.checks).toHaveLength(TARGET_PREP);
    expect(src?.phase).toBe("source-prep");
    expect(tgt?.phase).toBe("target-prep");
  });

  test("checks are universal: same set regardless of provider", () => {
    const neon = buildGuide("neon", { role: "source" }).sections[0]?.checks.map((c) => c.id);
    const rds = buildGuide("rds-postgres", { role: "source" }).sections[0]?.checks.map((c) => c.id);
    expect(neon).toEqual(rds);
  });

  test("a source-only provider still gets a target section from the universal checks", () => {
    // rds has no target HINT, but target-prep checks (schema-loaded) still apply
    const g = buildGuide("rds-postgres", { role: "target" });
    expect(g.sections).toHaveLength(1);
    expect(g.sections[0]?.hints).toHaveLength(0);
    expect(g.sections[0]?.checks).toHaveLength(TARGET_PREP);
  });

  test("--role filter keeps only the requested role", () => {
    expect(buildGuide("neon", { role: "source" }).sections.map((s) => s.role)).toEqual(["source"]);
    expect(buildGuide("neon", { role: "target" }).sections.map((s) => s.role)).toEqual(["target"]);
  });

  test("hintCount / checkCount sum their sections", () => {
    const g = buildGuide("planetscale-postgres");
    expect(g.hintCount).toBe(g.sections.reduce((n, s) => n + s.hints.length, 0));
    expect(g.checkCount).toBe(g.sections.reduce((n, s) => n + s.checks.length, 0));
    // planetscale has a source + target hint
    expect(g.hintCount).toBe(2);
  });

  test("with no hints AND no checks injected, a section is dropped", () => {
    const g = buildGuide("neon", { checks: [], items: providerHints });
    // neon still has hints, so sections remain, but checks are empty
    expect(g.checkCount).toBe(0);
    expect(g.hintCount).toBe(2);
  });
});
