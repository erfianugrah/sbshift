import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config.ts";
import { MgmtApi } from "../src/mgmt.ts";
import {
  type AddonType,
  formatPrice,
  planAddonChanges,
  planDisk,
  provision,
  type SelectedAddon,
  selectedVariant,
} from "../src/steps/provision.ts";

const addon = (type: AddonType, id: string, amount?: number): SelectedAddon => ({
  type,
  variant: {
    id,
    name: id,
    price: amount === undefined ? undefined : { amount, interval: "hourly" },
  },
});

// ── pure planners ────────────────────────────────────────────────────────
describe("selectedVariant / formatPrice", () => {
  test("finds the variant for a type", () => {
    expect(selectedVariant([addon("compute_instance", "ci_large")], "compute_instance")?.id).toBe(
      "ci_large",
    );
    expect(selectedVariant([], "pitr")).toBeNull();
  });
  test("formats price, tolerates missing", () => {
    expect(formatPrice({ amount: 0.1, interval: "hourly" })).toBe("$0.1/hourly");
    expect(formatPrice(undefined)).toBe("price n/a");
  });
});

describe("planAddonChanges — copy source, never strip", () => {
  test("upgrades target to source compute size", () => {
    const c = planAddonChanges(
      [addon("compute_instance", "ci_large", 0.1)],
      [addon("compute_instance", "ci_micro", 0.01)],
      ["compute_instance"],
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      addon_type: "compute_instance",
      addon_variant: "ci_large",
      from: "ci_micro",
    });
    expect(c[0]?.priceNote).toBe("$0.1/hourly");
  });

  test("no change when target already matches", () => {
    expect(
      planAddonChanges(
        [addon("compute_instance", "ci_large")],
        [addon("compute_instance", "ci_large")],
        ["compute_instance"],
      ),
    ).toEqual([]);
  });

  test("source lacks the addon → nothing planned (never strips target's)", () => {
    // target HAS pitr, source does not → we do NOT plan a removal
    expect(planAddonChanges([], [addon("pitr", "pitr_7")], ["pitr"])).toEqual([]);
  });

  test("from=null when target has no such addon yet", () => {
    const c = planAddonChanges([addon("pitr", "pitr_14", 0.2)], [], ["pitr"]);
    expect(c[0]).toMatchObject({ addon_variant: "pitr_14", from: null });
  });

  test("only enabled types are considered", () => {
    const c = planAddonChanges(
      [addon("compute_instance", "ci_large"), addon("ipv4", "ipv4_default")],
      [],
      ["compute_instance"],
    );
    expect(c.map((x) => x.addon_type)).toEqual(["compute_instance"]);
  });
});

describe("planDisk", () => {
  test("detects any attribute difference", () => {
    expect(
      planDisk({ type: "gp3", size_gb: 16, iops: 3000 }, { type: "gp3", size_gb: 8, iops: 3000 })
        .change,
    ).toBe(true);
    expect(
      planDisk({ type: "gp3", size_gb: 8, iops: 3000 }, { type: "gp3", size_gb: 8, iops: 3000 })
        .change,
    ).toBe(false);
    expect(
      planDisk({ type: "io2", size_gb: 8, iops: 3000 }, { type: "gp3", size_gb: 8, iops: 3000 })
        .change,
    ).toBe(true);
  });
  test("to=source, from=target", () => {
    const p = planDisk({ type: "gp3", size_gb: 16 }, { type: "gp3", size_gb: 8 });
    expect(p.to.size_gb).toBe(16);
    expect(p.from.size_gb).toBe(8);
  });
});

// ── orchestration against a path-aware fetch mock ──────────────────────────
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Captured {
  method: string;
  ref: string;
  path: string;
  body: unknown;
}

/** Mock keyed by `<ref><path>` for GETs; writes captured with their ref. */
function routeMock(getBodies: Record<string, unknown>): Captured[] {
  const writes: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const m = u.pathname.match(/\/v1\/projects\/([^/]+)(.*)$/);
    const ref = m?.[1] ?? "";
    const path = m?.[2] ?? "";
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      const key = ref + path;
      if (!(key in getBodies)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(getBodies[key]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    writes.push({ method, ref, path, body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
  return writes;
}

const SRC = "src_aaaaaaaaaaaaaaaa";
const TGT = "tgt_bbbbbbbbbbbbbbbb";

function cfg(over: Partial<Config["provision"]>): Config {
  return ConfigSchema.parse({
    source: { ref: SRC },
    target: { ref: TGT },
    replication: { tables: ["public.documents"] },
    reconcile: { tables: [{ name: "public.documents" }] },
    watchdog: {},
    provision: {
      compute: false,
      pitr: false,
      ipv4: false,
      disk: false,
      backupSchedule: false,
      ...over,
    },
  });
}
const api = () => new MgmtApi("sbp_test");

describe("provision orchestration", () => {
  test("preview (no --confirm) plans but performs NO writes", async () => {
    const writes = routeMock({
      [`${SRC}/billing/addons`]: { selected_addons: [addon("compute_instance", "ci_large", 0.1)] },
      [`${TGT}/billing/addons`]: { selected_addons: [addon("compute_instance", "ci_micro", 0.01)] },
    });
    const r = await provision(api(), cfg({ compute: true }), { confirm: false });
    expect(r.planned).toBe(1);
    expect(r.applied).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("--confirm PATCHes the addon onto the TARGET only", async () => {
    const writes = routeMock({
      [`${SRC}/billing/addons`]: { selected_addons: [addon("compute_instance", "ci_large", 0.1)] },
      [`${TGT}/billing/addons`]: { selected_addons: [addon("compute_instance", "ci_micro", 0.01)] },
    });
    const r = await provision(api(), cfg({ compute: true }), { confirm: true });
    expect(r.applied).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "PATCH",
      ref: TGT,
      path: "/billing/addons",
      body: { addon_type: "compute_instance", addon_variant: "ci_large" },
    });
  });

  test("matching target → no plan, no write", async () => {
    const writes = routeMock({
      [`${SRC}/billing/addons`]: { selected_addons: [addon("compute_instance", "ci_large")] },
      [`${TGT}/billing/addons`]: { selected_addons: [addon("compute_instance", "ci_large")] },
    });
    const r = await provision(api(), cfg({ compute: true }), { confirm: true });
    expect(r.planned).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("disk: POST {attributes} to target when differing", async () => {
    const writes = routeMock({
      [`${SRC}/config/disk`]: { attributes: { type: "gp3", size_gb: 16, iops: 3000 } },
      [`${TGT}/config/disk`]: { attributes: { type: "gp3", size_gb: 8, iops: 3000 } },
    });
    const r = await provision(api(), cfg({ disk: true }), { confirm: true });
    expect(r.applied).toBe(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/config/disk",
      body: { attributes: { type: "gp3", size_gb: 16, iops: 3000 } },
    });
  });

  test("backup schedule 402 (non-Enterprise) → skipped, no write, ok", async () => {
    // 402 GET → our mock returns 404 for unknown; emulate 402 by not providing + custom status.
    globalThis.fetch = (async () =>
      new Response("{}", { status: 402 })) as unknown as typeof globalThis.fetch;
    const r = await provision(api(), cfg({ backupSchedule: true }), { confirm: true });
    expect(r.planned).toBe(0);
    expect(r.ok).toBe(true);
  });

  test("nothing enabled → no GETs, ok", async () => {
    const writes = routeMock({});
    const r = await provision(api(), cfg({}), { confirm: true });
    expect(r).toEqual({ ok: true, planned: 0, applied: 0 });
    expect(writes).toHaveLength(0);
  });
});
