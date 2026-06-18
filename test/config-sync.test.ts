import { describe, expect, test } from "bun:test";
import { dropNulls, stripAuth, stripStorage } from "../src/steps/config-sync.ts";

describe("stripAuth — secrets must never be copied", () => {
  const input = {
    site_url: "https://example.com",
    jwt_exp: 3600,
    external_google_enabled: true,
    // all of the following MUST be stripped:
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
  };
  const out = stripAuth(input);

  test("keeps benign settings", () => {
    expect(out.site_url).toBe("https://example.com");
    expect(out.jwt_exp).toBe(3600);
    expect(out.external_google_enabled).toBe(true);
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
