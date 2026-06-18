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

/** Keys that must never be copied (they hold secrets or are target-specific). */
const AUTH_STRIP_EXACT = new Set([
  "rate_limit_email_sent",
  "rate_limit_sms_sent",
  "security_captcha_secret",
  "nimbus_oauth_client_secret",
  "db_max_pool_size",
  "db_max_pool_size_unit",
  "api_max_request_duration",
  "sessions_single_per_user",
  "sessions_tags",
]);
const AUTH_STRIP_PREFIX = [
  "smtp_",
  "sms_messagebird_",
  "sms_textlocal_",
  "sms_twilio_",
  "sms_vonage_",
  "sms_test_otp",
  "hook_mfa_verification_attempt_",
  "hook_password_verification_attempt_",
];

function stripAuth(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (AUTH_STRIP_EXACT.has(k)) continue;
    if (AUTH_STRIP_PREFIX.some((p) => k.startsWith(p))) continue;
    if (/passkey|web_?authn/.test(k)) continue;
    if (/_secrets?$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function dropNulls(src: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(src).filter(([, v]) => v !== null));
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
    transform: (s) => {
      const { capabilities, migrationVersion, databasePoolMode, features, ...rest } = s;
      return rest;
    },
  },
];

export async function configSync(
  api: MgmtApi,
  cfg: Config,
  opts: { dryRun: boolean },
): Promise<void> {
  log.step(`config-sync ${cfg.source.ref} -> ${cfg.target.ref}${opts.dryRun ? " (dry-run)" : ""}`);

  for (const section of SECTIONS) {
    if (!cfg.configSync[section.key]) continue;
    log.info(`--- ${section.label} ---`);

    const src = await api.get<Record<string, unknown>>(cfg.source.ref, section.getPath);
    if (src.status !== 200 || !src.body) {
      log.warn(`GET source ${section.label} failed (HTTP ${src.status}) — skipping`);
      continue;
    }

    const payload = section.transform(src.body);
    if (Object.keys(payload).length === 0) {
      log.warn(`${section.label}: nothing to apply after stripping — skipping`);
      continue;
    }

    if (opts.dryRun) {
      log.detail(
        `would ${section.method} ${Object.keys(payload).length} keys: ${Object.keys(payload).join(", ")}`,
      );
      continue;
    }

    const res = await api.write(cfg.target.ref, section.putPath, section.method, payload);
    if (res.status >= 200 && res.status < 300) {
      log.ok(`${section.label} applied (HTTP ${res.status})`);
    } else {
      log.err(
        `${section.label} ${section.method} failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`,
      );
    }
  }

  log.warn(
    "Secrets are NOT copied (SMTP, OAuth client secrets, SMS, JWT, captcha, passkey). Re-enter on target.",
  );
}
