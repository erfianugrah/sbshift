import { describe, expect, test } from "bun:test";
import { lookupProviderHint, providerHints } from "../src/kb/provider-hints.ts";
import { ProviderHints } from "../src/kb/schema.ts";

describe("provider-hints KB", () => {
  test("the whole catalog parses against the schema", () => {
    expect(() => ProviderHints.parse(providerHints)).not.toThrow();
  });

  test("ids are unique", () => {
    const ids = providerHints.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("(provider, role) pairs are unique — lookup is unambiguous", () => {
    const keys = providerHints.map((h) => `${h.provider}:${h.role}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every item carries a provenance source + ISO-dated lastSynced", () => {
    for (const h of providerHints) {
      expect(h.provenance.source.length).toBeGreaterThan(0);
      expect(h.provenance.lastSynced).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // a docs.erfi.io path or an http(s) vendor URL — nothing else is drift-checkable
      expect(h.provenance.source).toMatch(/^(\/docs\/|https?:\/\/)/);
    }
  });

  test("no entries for supabase or generic (handled elsewhere)", () => {
    expect(providerHints.some((h) => h.provider === "supabase")).toBe(false);
    expect(providerHints.some((h) => h.provider === "generic")).toBe(false);
  });

  test("lookup returns the matching item's guidance verbatim", () => {
    const rds = providerHints.find((h) => h.id === "rds-postgres.enable_logical_replication");
    expect(lookupProviderHint("rds-postgres", "source")).toBe(rds?.guidance ?? null);
  });

  test("lookup returns null for an absent (provider, role) pair", () => {
    expect(lookupProviderHint("rds-postgres", "target")).toBeNull();
    expect(lookupProviderHint("supabase", "source")).toBeNull();
    expect(lookupProviderHint("generic", "target")).toBeNull();
  });
});
