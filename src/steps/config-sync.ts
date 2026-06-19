import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { MgmtApi } from "../mgmt.ts";

/**
 * TS port of Supabase's documented sync_supabase_config.sh.
 * Copies non-data project configuration SOURCE -> TARGET via the Management API.
 *
 * SECURITY: every secret-bearing key is stripped before the payload is sent.
 * This is the auditable replacement for the bash `jq` filter. If you add a new
 * config section, extend STRIP rules below — do not relax them.
 */

type Section = {
  key: keyof Config["configSync"];
  label: string;
  getPath: string;
  method: "PATCH" | "PUT";
  putPath: string;
  transform: (src: Record<string, unknown>) => Record<string, unknown>;
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

export function stripAuth(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!isAuthSecret(k)) out[k] = v;
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

const SECTIONS: Section[] = [
  {
    key: "auth",
    label: "Auth",
    getPath: "/config/auth",
    method: "PATCH",
    putPath: "/config/auth",
    transform: stripAuth,
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
    transform: dropNulls,
  },
  {
    key: "storage",
    label: "Storage",
    getPath: "/config/storage",
    method: "PATCH",
    putPath: "/config/storage",
    transform: stripStorage,
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

    const payload = section.transform(src.body);
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
        log.detail(`  ${k} = ${JSON.stringify(v)}`);
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

  log.warn(
    "Secrets are NOT copied (SMTP, OAuth client secrets, SMS, JWT, captcha, passkey, hook credentials). Re-enter on target.",
  );
  return result;
}
