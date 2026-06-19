import { describe, expect, test } from "bun:test";
import { dropNulls, stripAuth, stripStorage } from "../src/steps/config-sync.ts";

describe("stripAuth — secrets must never be copied", () => {
  const input = {
    site_url: "https://example.com",
    jwt_exp: 3600,
    external_google_enabled: true,
    // M-6: behavioral settings — must be COPIED, not stripped
    sessions_single_per_user: true,
    api_max_request_duration: 300,
    db_max_pool_size: 25,
    sessions_tags: ["web"],
    // secrets — must be STRIPPED
    smtp_pass: "supersecret",
    smtp_user: "mailer",
    sms_twilio_auth_token: "tok",
    security_captcha_secret: "captcha",
    nimbus_oauth_client_secret: "oauth",
    external_apple_secret: "apple-secret",
    hook_mfa_verification_attempt_secrets: "hooksecret",
    passkey_rp_id: "example.com",
    webauthn_something: "x",
    rate_limit_email_sent: 30,
    // M-7: newer hook types — only credentials must be stripped, not config
    hook_send_sms_enabled: true,
    hook_send_sms_uri: "https://example.com/hook",
    hook_send_sms_secrets: "v1,whsec_abc",
    hook_custom_access_token_enabled: false,
    hook_custom_access_token_uri: "https://example.com/token",
    hook_custom_access_token_secret: "whsec_xyz",
    hook_custom_access_token_headers: JSON.stringify({ Authorization: "Bearer token" }),
  };
  const out = stripAuth(input);

  test("keeps benign settings", () => {
    expect(out.site_url).toBe("https://example.com");
    expect(out.jwt_exp).toBe(3600);
    expect(out.external_google_enabled).toBe(true);
  });

  test("M-6: copies behavioral settings (not secrets)", () => {
    expect(out.sessions_single_per_user).toBe(true);
    expect(out.api_max_request_duration).toBe(300);
    expect(out.db_max_pool_size).toBe(25);
    expect(out.sessions_tags).toEqual(["web"]);
  });

  test("strips every secret-bearing key", () => {
    for (const k of [
      "smtp_pass",
      "smtp_user",
      "sms_twilio_auth_token",
      "security_captcha_secret",
      "nimbus_oauth_client_secret",
      "external_apple_secret",
      "hook_mfa_verification_attempt_secrets",
      "passkey_rp_id",
      "webauthn_something",
      "rate_limit_email_sent",
    ]) {
      expect(out).not.toHaveProperty(k);
    }
  });

  test("no key matching _secret(s) survives", () => {
    for (const k of Object.keys(out)) {
      expect(/_secrets?$/.test(k)).toBe(false);
      expect(/^smtp_/.test(k)).toBe(false);
      expect(/passkey|web_?authn/.test(k)).toBe(false);
    }
  });

  test("M-7: newer hook types — copies enabled/uri, strips secrets/headers", () => {
    // non-credential hook config must be copied
    expect(out.hook_send_sms_enabled).toBe(true);
    expect(out.hook_send_sms_uri).toBe("https://example.com/hook");
    expect(out.hook_custom_access_token_enabled).toBe(false);
    expect(out.hook_custom_access_token_uri).toBe("https://example.com/token");
    // credentials must be stripped
    expect(out).not.toHaveProperty("hook_send_sms_secrets");
    expect(out).not.toHaveProperty("hook_custom_access_token_secret");
    expect(out).not.toHaveProperty("hook_custom_access_token_headers");
  });
});

describe("dropNulls / stripStorage", () => {
  test("dropNulls removes null values only", () => {
    expect(dropNulls({ a: 1, b: null, c: false, d: 0 })).toEqual({ a: 1, c: false, d: 0 });
  });

  test("stripStorage drops target-specific/read-only fields", () => {
    const out = stripStorage({
      fileSizeLimit: 50,
      capabilities: { x: 1 },
      migrationVersion: 12,
      databasePoolMode: "transaction",
      features: ["a"],
    });
    expect(out).toEqual({ fileSizeLimit: 50 });
  });
});
