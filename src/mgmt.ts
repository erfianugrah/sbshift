import { log } from "./log.ts";

const API_BASE = "https://api.supabase.com/v1";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MgmtApi {
  constructor(private token: string) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async get<T = unknown>(
    projectRef: string,
    path: string,
  ): Promise<{ status: number; body: T | null }> {
    const res = await fetch(`${API_BASE}/projects/${projectRef}${path}`, {
      headers: this.headers(),
    });
    const body = res.ok ? ((await res.json()) as T) : null;
    return { status: res.status, body };
  }

  async write(
    projectRef: string,
    path: string,
    method: "PATCH" | "PUT" | "POST",
    payload: unknown,
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(`${API_BASE}/projects/${projectRef}${path}`, {
      method,
      headers: this.headers(true),
      body: JSON.stringify(payload),
    });
    return { status: res.status, text: await res.text() };
  }

  /** POST /v1/projects — creates a new project; returns the project ref. */
  async createProject(
    name: string,
    organizationId: string,
    dbPass: string,
    region: string,
  ): Promise<string> {
    const res = await fetch(`${API_BASE}/projects`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ name, organization_id: organizationId, db_pass: dbPass, region }),
    });
    if (!res.ok) throw new Error(`createProject failed: HTTP ${res.status} ${await res.text()}`);
    const { ref } = (await res.json()) as { ref: string };
    return ref;
  }

  /** GET /v1/projects/:ref — returns the raw project object (status, region, etc.). */
  async getProject(ref: string): Promise<{ status: string; [k: string]: unknown }> {
    const res = await fetch(`${API_BASE}/projects/${ref}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getProject ${ref}: HTTP ${res.status}`);
    return res.json() as Promise<{ status: string }>;
  }

  /** Poll until every ref reaches ACTIVE_HEALTHY (default 10 min). */
  async waitHealthy(
    refs: string[],
    opts: { pollSec?: number; timeoutMin?: number } = {},
  ): Promise<void> {
    const { pollSec = 15, timeoutMin = 10 } = opts;
    const deadline = Date.now() + timeoutMin * 60_000;
    for (;;) {
      // L-3: tolerate transient 503s during the provision poll — a network blip
      // during a 10-minute wait should not abort the entire harness.
      let statuses: string[];
      try {
        statuses = await Promise.all(refs.map((r) => this.getProject(r).then((p) => p.status)));
      } catch (e) {
        log.warn(
          `waitHealthy: transient error polling project status — ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        if (Date.now() >= deadline) throw new Error("timed out waiting for ACTIVE_HEALTHY");
        await sleep(pollSec * 1_000);
        continue;
      }
      if (statuses.every((s) => s === "ACTIVE_HEALTHY")) return;
      if (Date.now() >= deadline) throw new Error("timed out waiting for ACTIVE_HEALTHY");
      log.detail(`waiting for ACTIVE_HEALTHY — ${statuses.join(", ")}`);
      await sleep(pollSec * 1_000);
    }
  }

  /** GET /v1/projects/:ref/config/database/pooler — returns session-pooler host+user. */
  async getPooler(ref: string): Promise<{ host: string; user: string }> {
    const { body } = await this.get<Array<{ db_host: string; db_user: string }>>(
      ref,
      "/config/database/pooler",
    );
    if (!body?.[0]) throw new Error(`No pooler config for project ${ref}`);
    return { host: body[0].db_host, user: body[0].db_user };
  }

  /** DELETE /v1/projects/:ref — best-effort teardown; ignores 404. */
  async deleteProject(ref: string): Promise<void> {
    const res = await fetch(`${API_BASE}/projects/${ref}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      log.warn(`deleteProject ${ref}: HTTP ${res.status} (ignored)`);
    }
  }

  /** Sanity check: token valid and both refs visible to this account. */
  async assertAccess(refs: string[]): Promise<void> {
    for (const ref of refs) {
      const { status } = await this.get(ref, "");
      if (status === 401) throw new Error("Management API 401 — SUPABASE_ACCESS_TOKEN invalid.");
      if (status === 403 || status === 404) {
        throw new Error(`No Owner/Admin access to project ${ref} (HTTP ${status}).`);
      }
      log.detail(`project ${ref} reachable (HTTP ${status})`);
    }
  }
}
