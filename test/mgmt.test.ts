/**
 * Unit tests for MgmtApi using Bun's built-in fetch mock.
 * H-1: mgmt.ts had zero test coverage; these cover the API shape, error paths,
 * and the waitHealthy retry behaviour added in L-3.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MgmtApi } from "../src/mgmt.ts";

const TOKEN = "sbp_test";

// Bun's global fetch is mockable via `mock.module` or by replacing globalThis.fetch.
// We replace globalThis.fetch and restore it in afterEach.
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function mockFetch(responses: Array<{ status: number; body: unknown }>): void {
  let i = 0;
  // Cast needed: Bun's `fetch` type includes a `preconnect` method that we don't
  // need to mock for these tests.
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[i++ % responses.length] ?? { status: 500, body: "no mock" };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("MgmtApi.get", () => {
  test("returns body on 200", async () => {
    mockFetch([{ status: 200, body: { foo: 1 } }]);
    const api = new MgmtApi(TOKEN);
    const r = await api.get("ref123", "/config/auth");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ foo: 1 });
  });

  test("returns null body on non-2xx", async () => {
    mockFetch([{ status: 404, body: "not found" }]);
    const api = new MgmtApi(TOKEN);
    const r = await api.get("ref123", "/config/auth");
    expect(r.status).toBe(404);
    expect(r.body).toBeNull();
  });
});

describe("MgmtApi.write", () => {
  test("returns status + text", async () => {
    mockFetch([{ status: 200, body: { ok: true } }]);
    const api = new MgmtApi(TOKEN);
    const r = await api.write("ref123", "/config/auth", "PATCH", { jwt_exp: 3600 });
    expect(r.status).toBe(200);
    expect(r.text).toContain("ok");
  });
});

describe("MgmtApi.createProject", () => {
  test("returns ref on success", async () => {
    mockFetch([{ status: 201, body: { ref: "abcdef123456" } }]);
    const api = new MgmtApi(TOKEN);
    const ref = await api.createProject("test", "org1", "pass", "us-east-1");
    expect(ref).toBe("abcdef123456");
  });

  test("throws on HTTP error", async () => {
    mockFetch([{ status: 422, body: "validation error" }]);
    const api = new MgmtApi(TOKEN);
    await expect(api.createProject("bad", "org", "pw", "us-east-1")).rejects.toThrow("HTTP 422");
  });
});

describe("MgmtApi.deleteProject", () => {
  test("resolves on 200", async () => {
    mockFetch([{ status: 200, body: {} }]);
    const api = new MgmtApi(TOKEN);
    await expect(api.deleteProject("ref123")).resolves.toBeUndefined();
  });

  test("resolves on 404 (idempotent)", async () => {
    mockFetch([{ status: 404, body: "not found" }]);
    const api = new MgmtApi(TOKEN);
    await expect(api.deleteProject("ref123")).resolves.toBeUndefined();
  });

  test("does not throw on non-404 error (best-effort)", async () => {
    mockFetch([{ status: 500, body: "server error" }]);
    const api = new MgmtApi(TOKEN);
    // deleteProject logs a warning but doesn't throw
    await expect(api.deleteProject("ref123")).resolves.toBeUndefined();
  });
});

describe("MgmtApi.waitHealthy — L-3 transient-error tolerance", () => {
  test("resolves when all refs reach ACTIVE_HEALTHY immediately", async () => {
    mockFetch([
      { status: 200, body: { status: "ACTIVE_HEALTHY" } },
      { status: 200, body: { status: "ACTIVE_HEALTHY" } },
    ]);
    const api = new MgmtApi(TOKEN);
    await expect(api.waitHealthy(["r1", "r2"], { pollSec: 0 })).resolves.toBeUndefined();
  });

  test("retries after a transient 503 and resolves on next poll", async () => {
    // First getProject call throws (simulates a 503 parse error), second call succeeds.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls <= 2) {
        throw new Error("fetch failed: connection reset");
      }
      return new Response(JSON.stringify({ status: "ACTIVE_HEALTHY" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const api = new MgmtApi(TOKEN);
    await expect(api.waitHealthy(["r1"], { pollSec: 0 })).resolves.toBeUndefined();
  });

  test("throws when deadline expires", async () => {
    mockFetch([{ status: 200, body: { status: "COMING_UP" } }]);
    const api = new MgmtApi(TOKEN);
    await expect(api.waitHealthy(["r1"], { pollSec: 0, timeoutMin: 0.001 })).rejects.toThrow(
      "timed out",
    );
  });
});

describe("MgmtApi.assertAccess", () => {
  test("resolves when all refs return 200", async () => {
    mockFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const api = new MgmtApi(TOKEN);
    await expect(api.assertAccess(["r1", "r2"])).resolves.toBeUndefined();
  });

  test("throws on 401 (invalid token)", async () => {
    mockFetch([{ status: 401, body: {} }]);
    const api = new MgmtApi(TOKEN);
    await expect(api.assertAccess(["r1"])).rejects.toThrow("401");
  });

  test("throws on 404 (no access)", async () => {
    mockFetch([{ status: 404, body: {} }]);
    const api = new MgmtApi(TOKEN);
    await expect(api.assertAccess(["r1"])).rejects.toThrow("404");
  });
});
