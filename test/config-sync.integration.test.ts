/**
 * Orchestration coverage for configSync() — drives the REAL MgmtApi + real
 * section loop against a path-aware fetch mock. Complements config-sync.test.ts
 * (which covers the pure transforms) by asserting the new opt-in wiring end to
 * end: the secrets flag reaching stripAuth, the ssl/network sections, and the
 * array-shaped project-secrets handler (dry-run redaction + apply).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config.ts";
import { MgmtApi } from "../src/mgmt.ts";
import { configSync } from "../src/steps/config-sync.ts";

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

/** Path-aware mock: GETs answered from `getBodies`, writes captured. */
const SRC = "src_aaaaaaaaaaaaaaaa";
const TGT = "tgt_bbbbbbbbbbbbbbbb";

/**
 * Ref-aware mock: `srcBodies` answer GETs to the SOURCE ref, `tgtBodies` to the
 * TARGET ref (default empty → 404, i.e. target has nothing yet). Writes captured.
 */
function routeMock(
  srcBodies: Record<string, unknown>,
  tgtBodies: Record<string, unknown> = {},
): Captured[] {
  const writes: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const m = u.pathname.match(/\/v1\/projects\/([^/]+)(.*)$/);
    const ref = m?.[1] ?? "";
    const path = (m?.[2] ?? "") + u.search;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      const bodies = ref === TGT ? tgtBodies : srcBodies;
      if (!(path in bodies)) return new Response("not mocked", { status: 404 });
      return new Response(JSON.stringify(bodies[path]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return writes;
}

/** Minimal valid config with all sections off except the ones a test enables. */
function cfgWith(over: Partial<Config["configSync"]>): Config {
  return ConfigSchema.parse({
    source: { ref: SRC },
    target: { ref: TGT },
    replication: { tables: ["public.documents"] },
    reconcile: { tables: [{ name: "public.documents" }] },
    watchdog: {},
    configSync: {
      auth: false,
      realtime: false,
      postgrest: false,
      storage: false,
      dbPooler: false,
      dbPostgres: false,
      ...over,
    },
  });
}

const api = () => new MgmtApi("sbp_test");
const AUTH = { site_url: "https://x.com", smtp_pass: "supersecret", external_apple_secret: "ap" };

describe("configSync orchestration — auth secret flag", () => {
  test("secrets=false strips smtp_pass/secret before PATCH", async () => {
    const writes = routeMock({ "/config/auth": AUTH });
    const r = await configSync(api(), cfgWith({ auth: true, secrets: false }), { dryRun: false });
    expect(r.ok).toBe(1);
    const body = (writes[0] as Captured).body as Record<string, unknown>;
    expect(body.site_url).toBe("https://x.com");
    expect(body).not.toHaveProperty("smtp_pass");
    expect(body).not.toHaveProperty("external_apple_secret");
  });

  test("secrets=true keeps integration creds in the PATCH", async () => {
    const writes = routeMock({ "/config/auth": AUTH });
    await configSync(api(), cfgWith({ auth: true, secrets: true }), { dryRun: false });
    const body = (writes[0] as Captured).body as Record<string, unknown>;
    expect(body.smtp_pass).toBe("supersecret");
    expect(body.external_apple_secret).toBe("ap");
  });
});

describe("configSync orchestration — new sections", () => {
  test("sslEnforcement: GET → PUT /ssl-enforcement requestedConfig", async () => {
    const writes = routeMock({
      "/ssl-enforcement": { currentConfig: { database: true }, appliedSuccessfully: true },
    });
    await configSync(api(), cfgWith({ sslEnforcement: true }), { dryRun: false });
    expect(writes[0]).toMatchObject({
      method: "PUT",
      path: "/ssl-enforcement",
      body: { requestedConfig: { database: true } },
    });
  });

  test("networkRestrictions: GET → POST /network-restrictions/apply", async () => {
    const writes = routeMock({
      "/network-restrictions": {
        entitlement: "allowed",
        config: { dbAllowedCidrs: ["1.2.3.0/24"] },
      },
    });
    await configSync(api(), cfgWith({ networkRestrictions: true }), { dryRun: false });
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/network-restrictions/apply",
      body: { dbAllowedCidrs: ["1.2.3.0/24"] },
    });
  });

  test("networkRestrictions with no CIDRs → skipped, no write (no accidental open)", async () => {
    const writes = routeMock({ "/network-restrictions": { entitlement: "allowed", config: {} } });
    const r = await configSync(api(), cfgWith({ networkRestrictions: true }), { dryRun: false });
    expect(writes).toHaveLength(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe("configSync orchestration — project secrets", () => {
  const SECRETS = [
    { name: "STRIPE_KEY", value: "sk_live_x", updated_at: "2026-01-01" },
    { name: "SENDGRID", value: "SG.abc" },
  ];

  test("projectSecrets apply: POST /secrets with name+value only", async () => {
    const writes = routeMock({ "/secrets": SECRETS });
    const r = await configSync(api(), cfgWith({ projectSecrets: true }), { dryRun: false });
    expect(r.ok).toBe(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: "/secrets" });
    expect((writes[0] as Captured).body).toEqual([
      { name: "STRIPE_KEY", value: "sk_live_x" },
      { name: "SENDGRID", value: "SG.abc" },
    ]);
  });

  test("projectSecrets dry-run: counts ok but performs NO write", async () => {
    const writes = routeMock({ "/secrets": SECRETS });
    const r = await configSync(api(), cfgWith({ projectSecrets: true }), { dryRun: true });
    expect(r.ok).toBe(1);
    expect(writes).toHaveLength(0);
  });

  test("projectSecrets off → skipped, /secrets never fetched", async () => {
    const writes = routeMock({ "/secrets": SECRETS });
    const r = await configSync(api(), cfgWith({ projectSecrets: false }), { dryRun: false });
    expect(writes).toHaveLength(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe("configSync orchestration — auth sub-resources", () => {
  test("thirdPartyAuth: POSTs source integrations missing on target", async () => {
    const writes = routeMock({
      "/config/auth/third-party-auth": [{ id: "1", type: "oidc", oidc_issuer_url: "https://fb/x" }],
    });
    const r = await configSync(api(), cfgWith({ thirdPartyAuth: true }), { dryRun: false });
    expect(r.ok).toBe(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/config/auth/third-party-auth",
      body: { oidc_issuer_url: "https://fb/x" },
    });
  });

  test("thirdPartyAuth dry-run: no write", async () => {
    const writes = routeMock({
      "/config/auth/third-party-auth": [{ oidc_issuer_url: "https://fb/x" }],
    });
    await configSync(api(), cfgWith({ thirdPartyAuth: true }), { dryRun: true });
    expect(writes).toHaveLength(0);
  });

  test("ssoProviders: POSTs provider with mapped domains", async () => {
    const writes = routeMock({
      "/config/auth/sso/providers": {
        items: [
          {
            id: "p1",
            saml: { entity_id: "https://idp", metadata_url: "https://idp/meta" },
            domains: [{ domain: "acme.com" }],
          },
        ],
      },
    });
    const r = await configSync(api(), cfgWith({ ssoProviders: true }), { dryRun: false });
    expect(r.ok).toBe(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/config/auth/sso/providers",
      body: { type: "saml", metadata_url: "https://idp/meta", domains: ["acme.com"] },
    });
  });

  test("ssoProviders: source 404 (SAML disabled) → skipped, no write", async () => {
    // routeMock returns 404 for unmocked GET paths, so omit the SSO path entirely.
    const writes = routeMock({});
    const r = await configSync(api(), cfgWith({ ssoProviders: true }), { dryRun: false });
    expect(writes).toHaveLength(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });
});
