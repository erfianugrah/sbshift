import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { MgmtApi } from "../mgmt.ts";

/**
 * TS port of Supabase's documented sync_supabase_config.sh.
 * Copies non-data project configuration SOURCE -> TARGET via the Management API.
 *
 * SECURITY: by default every secret-bearing key is stripped before the payload
 * is sent (the auditable replacement for the bash `jq` filter). Copying auth
 * integration secrets (SMTP/OAuth/SMS/hook creds) and project/Edge-Function
 * secrets is OPT-IN via configSync.secrets / configSync.projectSecrets. The JWT
 * signing secret + API keys are never in these payloads (separate endpoints),
 * so they can never be cloned here. If you add a new config section, extend the
 * STRIP rules below — do not relax the default-strip behaviour.
 */

type Section = {
  key: keyof Config["configSync"];
  label: string;
  getPath: string;
  method: "PATCH" | "PUT" | "POST";
  putPath: string;
  transform: (src: Record<string, unknown>, cfg?: Config) => Record<string, unknown>;
};

/** Keys that must never be copied because they hold secrets. */
const AUTH_STRIP_SECRET = new Set([
  "security_captcha_secret",
  "nimbus_oauth_client_secret",
  "rate_limit_email_sent",
  "rate_limit_sms_sent",
]);

/**
 * M-6: Removed non-secret behavioral settings from the strip set.
 * `sessions_single_per_user`, `db_max_pool_size`, `api_max_request_duration`
 * etc. are operational config — they SHOULD be copied so the target behaves
 * identically to the source.
 *
 * M-7: Hook secrets use an explicit predicate instead of an incomplete prefix
 * deny-list. The deny-list named only two hook types; Supabase continues to add
 * hooks (`hook_send_sms_`, `hook_custom_access_token_`, etc.). An allowlist
 * approach on the key SUFFIX is safer: strip any hook's `_secret`/`_secrets`/
 * `_headers` keys (which carry credentials), and copy `_enabled`/`_uri`.
 */
function isAuthSecret(k: string): boolean {
  if (AUTH_STRIP_SECRET.has(k)) return true;
  // SMTP + SMS provider credentials
  if (/^smtp_/.test(k)) return true;
  if (/^sms_(messagebird|textlocal|twilio|vonage)_/.test(k)) return true;
  if (/^sms_test_otp/.test(k)) return true;
  // Passkey / WebAuthn credentials
  if (/passkey|web_?authn/.test(k)) return true;
  // Any key whose name ends in _secret or _secrets (covers all current + future hooks)
  if (/_secrets?$/.test(k)) return true;
  // Hook credential headers (contain auth tokens, not safe to copy)
  if (/^hook_.*_headers?$/.test(k)) return true;
  return false;
}

/**
 * Dry-run logs should never print credential material even when secret-copying
 * is explicitly enabled. This is display-only redaction; payload stripping is
 * still enforced by section-specific transforms.
 */
export function isSensitiveKey(k: string): boolean {
  if (isAuthSecret(k)) return true;
  // Non-auth secret-ish keys that can appear in other sections.
  if (/jwt[_-]?secret/i.test(k)) return true;
  return false;
}

export function dryRunValue(k: string, v: unknown): string {
  return isSensitiveKey(k) ? '"****"' : JSON.stringify(v);
}

/**
 * Strip auth secrets unless `copySecrets` is set. When copying, the integration
 * creds (SMTP/OAuth/SMS/hook secrets) ARE kept — these are the 3rd-party
 * credentials an operator wants to carry across on a migration. The JWT signing
 * secret + API keys are NOT in this payload at all (separate endpoints), so
 * copying here can never clone the project's signing key.
 */
export function stripAuth(
  src: Record<string, unknown>,
  copySecrets = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (copySecrets || !isAuthSecret(k)) out[k] = v;
  }
  return out;
}

/** Pure transform for network-restrictions GET → POST /apply body. Exported for tests. */
export function toNetworkRestrictions(src: Record<string, unknown>): Record<string, unknown> {
  const c = (src.config ?? {}) as { dbAllowedCidrs?: string[]; dbAllowedCidrsV6?: string[] };
  const out: Record<string, unknown> = {};
  if (Array.isArray(c.dbAllowedCidrs)) out.dbAllowedCidrs = c.dbAllowedCidrs;
  if (Array.isArray(c.dbAllowedCidrsV6)) out.dbAllowedCidrsV6 = c.dbAllowedCidrsV6;
  return out;
}

/** Pure transform for ssl-enforcement GET → PUT body. Exported for tests. */
export function toSslEnforcement(src: Record<string, unknown>): Record<string, unknown> {
  const cc = (src.currentConfig ?? {}) as { database?: boolean };
  return { requestedConfig: { database: Boolean(cc.database) } };
}

/** Pure transform for project /secrets GET → bulk POST body. Exported for tests. */
export function toProjectSecrets(
  src: Array<{ name?: unknown; value?: unknown }>,
): Array<{ name: string; value: string }> {
  return src
    .filter((s) => s && typeof s.name === "string" && typeof s.value === "string")
    .map((s) => ({ name: s.name as string, value: s.value as string }));
}

// ── Auth sub-resources (separate endpoints the /config/auth blob does NOT carry) ──

export interface ThirdPartyAuth {
  id?: string;
  type?: string;
  oidc_issuer_url?: string;
  jwks_url?: string;
  custom_jwks?: unknown;
}
export interface TpaPost {
  oidc_issuer_url?: string;
  jwks_url?: string;
  custom_jwks?: unknown;
}

/** Identity of a third-party-auth integration (issuer or JWKS url). */
export function tpaKey(t: { oidc_issuer_url?: string; jwks_url?: string }): string {
  return t.oidc_issuer_url ?? t.jwks_url ?? "";
}

/** Pure: POST bodies for source TPA integrations missing on the target (additive). Exported for tests. */
export function planThirdPartyAuth(src: ThirdPartyAuth[], tgt: ThirdPartyAuth[]): TpaPost[] {
  const have = new Set(tgt.map(tpaKey).filter(Boolean));
  const out: TpaPost[] = [];
  for (const t of src) {
    const k = tpaKey(t);
    if (!k || have.has(k)) continue;
    const body: TpaPost = {};
    if (t.oidc_issuer_url) body.oidc_issuer_url = t.oidc_issuer_url;
    if (t.jwks_url) body.jwks_url = t.jwks_url;
    if (t.custom_jwks != null) body.custom_jwks = t.custom_jwks;
    out.push(body);
  }
  return out;
}

export interface SamlProvider {
  id?: string;
  saml?: {
    entity_id?: string;
    metadata_url?: string;
    metadata_xml?: string;
    attribute_mapping?: unknown;
    name_id_format?: string;
  };
  domains?: Array<{ domain?: string }>;
}
export interface SsoPost {
  type: "saml";
  metadata_url?: string;
  metadata_xml?: string;
  domains?: string[];
  attribute_mapping?: unknown;
  name_id_format?: string;
}

/**
 * Pure: POST bodies for source SSO/SAML providers missing on the target, keyed
 * by SAML entity_id (additive). Prefers metadata_url over metadata_xml so the
 * target re-fetches fresh metadata. Exported for tests.
 */
export function planSsoProviders(src: SamlProvider[], tgt: SamlProvider[]): SsoPost[] {
  const have = new Set(tgt.map((p) => p.saml?.entity_id).filter(Boolean));
  const out: SsoPost[] = [];
  for (const p of src) {
    const eid = p.saml?.entity_id;
    if (!eid || have.has(eid)) continue;
    const body: SsoPost = { type: "saml" };
    if (p.saml?.metadata_url) body.metadata_url = p.saml.metadata_url;
    else if (p.saml?.metadata_xml) body.metadata_xml = p.saml.metadata_xml;
    const domains = (p.domains ?? [])
      .map((d) => d.domain)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
    if (domains.length > 0) body.domains = domains;
    if (p.saml?.attribute_mapping != null) body.attribute_mapping = p.saml.attribute_mapping;
    if (p.saml?.name_id_format) body.name_id_format = p.saml.name_id_format;
    out.push(body);
  }
  return out;
}

export function dropNulls(src: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(src).filter(([, v]) => v !== null));
}

// L-15: use a named strip set instead of `void varName` noise suppression.
const STORAGE_STRIP = new Set(["capabilities", "migrationVersion", "databasePoolMode", "features"]);
export function stripStorage(s: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(s).filter(([k]) => !STORAGE_STRIP.has(k)));
}

/**
 * JWT/API signing material must never be copied to a new project by design.
 * PostgREST exposes `jwt_secret`; drop it unconditionally.
 */
export function stripPostgrest(s: Record<string, unknown>): Record<string, unknown> {
  const { jwt_secret: _drop, ...rest } = s as Record<string, unknown>;
  return dropNulls(rest);
}

const SECTIONS: Section[] = [
  {
    key: "auth",
    label: "Auth",
    getPath: "/config/auth",
    method: "PATCH",
    putPath: "/config/auth",
    transform: (s, cfg) => stripAuth(s, cfg?.configSync.secrets ?? false),
  },
  {
    key: "realtime",
    label: "Realtime",
    getPath: "/config/realtime",
    method: "PATCH",
    putPath: "/config/realtime",
    transform: (s) => s,
  },
  {
    key: "dbPooler",
    label: "Database Pooler",
    getPath: "/config/database/pooler",
    method: "PATCH",
    putPath: "/config/database/pooler",
    transform: (s) => {
      const obj = Array.isArray(s) ? (s[0] as Record<string, unknown>) : s;
      return dropNulls({ default_pool_size: obj?.default_pool_size, pool_mode: obj?.pool_mode });
    },
  },
  {
    key: "dbPostgres",
    label: "Database Postgres",
    getPath: "/config/database/postgres",
    method: "PUT",
    putPath: "/config/database/postgres",
    transform: (s) => s,
  },
  {
    key: "postgrest",
    label: "PostgREST",
    getPath: "/postgrest",
    method: "PATCH",
    putPath: "/postgrest",
    transform: stripPostgrest,
  },
  {
    key: "storage",
    label: "Storage",
    getPath: "/config/storage",
    method: "PATCH",
    putPath: "/config/storage",
    transform: stripStorage,
  },
  {
    key: "sslEnforcement",
    label: "SSL Enforcement",
    getPath: "/ssl-enforcement",
    method: "PUT",
    putPath: "/ssl-enforcement",
    transform: toSslEnforcement,
  },
  {
    key: "networkRestrictions",
    label: "Network Restrictions",
    getPath: "/network-restrictions",
    method: "POST",
    putPath: "/network-restrictions/apply",
    transform: toNetworkRestrictions,
  },
];

export interface ConfigSyncResult {
  ok: number;
  err: number;
  skipped: number;
}

export async function configSync(
  api: MgmtApi,
  cfg: Config,
  opts: { dryRun: boolean },
): Promise<ConfigSyncResult> {
  log.step(`config-sync ${cfg.source.ref} -> ${cfg.target.ref}${opts.dryRun ? " (dry-run)" : ""}`);
  const result: ConfigSyncResult = { ok: 0, err: 0, skipped: 0 };

  for (const section of SECTIONS) {
    if (!cfg.configSync[section.key]) {
      result.skipped++;
      continue;
    }
    log.info(`--- ${section.label} ---`);

    const src = await api.get<Record<string, unknown>>(cfg.source.ref, section.getPath);
    if (src.status !== 200 || !src.body) {
      log.warn(`GET source ${section.label} failed (HTTP ${src.status}) — skipping`);
      result.skipped++;
      continue;
    }

    const payload = section.transform(src.body, cfg);
    if (Object.keys(payload).length === 0) {
      log.warn(`${section.label}: nothing to apply after stripping — skipping`);
      result.skipped++;
      continue;
    }

    if (opts.dryRun) {
      // M-3: show key=value pairs, not just key names, so the operator can
      // actually "eyeball the diff" as the docs promise.
      log.detail(`would ${section.method} ${Object.keys(payload).length} keys:`);
      for (const [k, v] of Object.entries(payload)) {
        log.detail(`  ${k} = ${dryRunValue(k, v)}`);
      }
      result.ok++;
      continue;
    }

    const res = await api.write(cfg.target.ref, section.putPath, section.method, payload);
    if (res.status >= 200 && res.status < 300) {
      log.ok(`${section.label} applied (HTTP ${res.status})`);
      result.ok++;
    } else {
      log.err(
        `${section.label} ${section.method} failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`,
      );
      result.err++;
    }
  }

  // Project (Edge Function) secrets — array-shaped, so handled outside SECTIONS.
  if (cfg.configSync.projectSecrets) {
    const verdict = await syncProjectSecrets(api, cfg, opts);
    result[verdict]++;
  } else {
    result.skipped++;
  }

  // Auth sub-resources on separate endpoints (not in the /config/auth blob).
  if (cfg.configSync.thirdPartyAuth) {
    result[await syncThirdPartyAuth(api, cfg, opts)]++;
  } else {
    result.skipped++;
  }
  if (cfg.configSync.ssoProviders) {
    result[await syncSsoProviders(api, cfg, opts)]++;
  } else {
    result.skipped++;
  }

  if (cfg.configSync.secrets || cfg.configSync.projectSecrets) {
    log.warn(
      "Auth/project integration secrets WERE copied per config. The JWT signing secret + API keys " +
        "are still NOT copied (new project = new keys). Org-level data (settings, members/roles, " +
        "entitlements) is read-only in the Management API and does NOT migrate \u2014 re-invite the team by hand.",
    );
  } else {
    log.warn(
      "Secrets are NOT copied (SMTP, OAuth client secrets, SMS, JWT, captcha, passkey, hook credentials). " +
        "Re-enter on target, or set configSync.secrets / configSync.projectSecrets to copy integration creds. " +
        "Org-level data (settings, members/roles, entitlements) is read-only in the Management API " +
        "and does NOT migrate \u2014 re-invite the team on the target org by hand.",
    );
  }
  return result;
}

/**
 * Copy project (Edge Function) secrets via the bulk /secrets endpoint.
 * Plaintext values — opt-in via configSync.projectSecrets. Dry-run REDACTS
 * values (names only) so the audit log never captures the secret material.
 */
async function syncProjectSecrets(
  api: MgmtApi,
  cfg: Config,
  opts: { dryRun: boolean },
): Promise<"ok" | "err" | "skipped"> {
  log.info("--- Project Secrets (Edge Function env) ---");
  const src = await api.get<Array<{ name?: unknown; value?: unknown }>>(cfg.source.ref, "/secrets");
  if (src.status !== 200 || !Array.isArray(src.body)) {
    log.warn(`GET source project secrets failed (HTTP ${src.status}) \u2014 skipping`);
    return "skipped";
  }
  const payload = toProjectSecrets(src.body);
  if (payload.length === 0) {
    log.warn("no project secrets to copy \u2014 skipping");
    return "skipped";
  }
  if (opts.dryRun) {
    log.detail(`would POST ${payload.length} project secrets (values redacted):`);
    for (const s of payload) log.detail(`  ${s.name} = ****`);
    return "ok";
  }
  const res = await api.write(cfg.target.ref, "/secrets", "POST", payload);
  if (res.status >= 200 && res.status < 300) {
    log.ok(`Project Secrets applied: ${payload.length} (HTTP ${res.status})`);
    return "ok";
  }
  log.err(`Project Secrets POST failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
  return "err";
}

/** Recreate third-party-auth integrations missing on the target (additive). */
async function syncThirdPartyAuth(
  api: MgmtApi,
  cfg: Config,
  opts: { dryRun: boolean },
): Promise<"ok" | "err" | "skipped"> {
  log.info("--- Third-Party Auth integrations ---");
  const [src, tgt] = await Promise.all([
    api.get<ThirdPartyAuth[]>(cfg.source.ref, "/config/auth/third-party-auth"),
    api.get<ThirdPartyAuth[]>(cfg.target.ref, "/config/auth/third-party-auth"),
  ]);
  if (src.status !== 200 || !Array.isArray(src.body)) {
    log.warn(`GET source third-party-auth failed (HTTP ${src.status}) \u2014 skipping`);
    return "skipped";
  }
  const plan = planThirdPartyAuth(src.body, Array.isArray(tgt.body) ? tgt.body : []);
  if (plan.length === 0) {
    log.ok("third-party-auth: target already has all source integrations (or source has none)");
    return "skipped";
  }
  if (opts.dryRun) {
    for (const b of plan)
      log.detail(`would POST third-party-auth: ${b.oidc_issuer_url ?? b.jwks_url}`);
    return "ok";
  }
  let ok = true;
  for (const b of plan) {
    const res = await api.write(cfg.target.ref, "/config/auth/third-party-auth", "POST", b);
    if (res.status >= 200 && res.status < 300) {
      log.ok(`added third-party-auth: ${b.oidc_issuer_url ?? b.jwks_url}`);
    } else {
      ok = false;
      log.err(`third-party-auth POST failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
  }
  return ok ? "ok" : "err";
}

/** Recreate SSO/SAML providers missing on the target (additive, keyed by entity_id). */
async function syncSsoProviders(
  api: MgmtApi,
  cfg: Config,
  opts: { dryRun: boolean },
): Promise<"ok" | "err" | "skipped"> {
  log.info("--- SSO / SAML providers ---");
  const [src, tgt] = await Promise.all([
    api.get<{ items?: SamlProvider[] }>(cfg.source.ref, "/config/auth/sso/providers"),
    api.get<{ items?: SamlProvider[] }>(cfg.target.ref, "/config/auth/sso/providers"),
  ]);
  // 404 = SAML 2.0 not enabled for this project.
  if (src.status === 404) {
    log.ok("SSO: SAML 2.0 not enabled on source \u2014 nothing to migrate");
    return "skipped";
  }
  if (src.status !== 200 || !src.body) {
    log.warn(`GET source SSO providers failed (HTTP ${src.status}) \u2014 skipping`);
    return "skipped";
  }
  const tgtItems = tgt.status === 200 && tgt.body?.items ? tgt.body.items : [];
  const plan = planSsoProviders(src.body.items ?? [], tgtItems);
  if (plan.length === 0) {
    log.ok("SSO: target already has all source providers (or source has none)");
    return "skipped";
  }
  if (opts.dryRun) {
    for (const b of plan)
      log.detail(`would POST SSO provider (domains: ${(b.domains ?? []).join(",") || "none"})`);
    return "ok";
  }
  let ok = true;
  for (const b of plan) {
    const res = await api.write(cfg.target.ref, "/config/auth/sso/providers", "POST", b);
    if (res.status >= 200 && res.status < 300) {
      log.ok(`added SSO provider (domains: ${(b.domains ?? []).join(",") || "none"})`);
    } else if (res.status === 404) {
      ok = false;
      log.err(
        "SSO POST got 404 \u2014 SAML 2.0 is not enabled on the TARGET; enable it (plan feature) first",
      );
    } else {
      ok = false;
      log.err(`SSO provider POST failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
  }
  return ok ? "ok" : "err";
}
