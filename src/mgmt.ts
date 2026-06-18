import { log } from "./log.ts";

const API_BASE = "https://api.supabase.com/v1";

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
