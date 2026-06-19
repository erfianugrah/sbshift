import { describe, expect, test } from "bun:test";
import {
  dropNulls,
  planSsoProviders,
  planThirdPartyAuth,
  type SamlProvider,
  stripAuth,
  stripStorage,
  type ThirdPartyAuth,
  toNetworkRestrictions,
  toProjectSecrets,
  toSslEnforcement,
  tpaKey,
} from "../src/steps/config-sync.ts";

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

describe("stripAuth copySecrets=true — integration creds are kept", () => {
  const input = {
    site_url: "https://example.com",
    smtp_pass: "supersecret",
    external_apple_secret: "apple",
    sms_twilio_auth_token: "tok",
    hook_send_sms_secrets: "v1,whsec_abc",
  };
  test("copies secrets when opted in", () => {
    const out = stripAuth(input, true);
    expect(out.smtp_pass).toBe("supersecret");
    expect(out.external_apple_secret).toBe("apple");
    expect(out.sms_twilio_auth_token).toBe("tok");
    expect(out.hook_send_sms_secrets).toBe("v1,whsec_abc");
    expect(out.site_url).toBe("https://example.com");
  });
  test("default (no flag) still strips", () => {
    const out = stripAuth(input);
    expect(out).not.toHaveProperty("smtp_pass");
    expect(out).not.toHaveProperty("external_apple_secret");
    expect(out.site_url).toBe("https://example.com");
  });
});

describe("toSslEnforcement", () => {
  test("maps currentConfig.database → requestedConfig.database", () => {
    expect(
      toSslEnforcement({ currentConfig: { database: true }, appliedSuccessfully: true }),
    ).toEqual({
      requestedConfig: { database: true },
    });
    expect(toSslEnforcement({ currentConfig: { database: false } })).toEqual({
      requestedConfig: { database: false },
    });
  });
  test("missing currentConfig coerces to false (never undefined)", () => {
    expect(toSslEnforcement({})).toEqual({ requestedConfig: { database: false } });
  });
});

describe("toNetworkRestrictions", () => {
  test("lifts config CIDR arrays into the apply body", () => {
    expect(
      toNetworkRestrictions({
        entitlement: "allowed",
        config: { dbAllowedCidrs: ["1.2.3.0/24"], dbAllowedCidrsV6: ["::/0"] },
      }),
    ).toEqual({ dbAllowedCidrs: ["1.2.3.0/24"], dbAllowedCidrsV6: ["::/0"] });
  });
  test("omits absent arrays → empty object → section skipped (no accidental open)", () => {
    expect(toNetworkRestrictions({ config: {} })).toEqual({});
    expect(toNetworkRestrictions({})).toEqual({});
  });
});

describe("toProjectSecrets", () => {
  test("keeps name+value, drops updated_at and malformed rows", () => {
    const out = toProjectSecrets([
      { name: "STRIPE_KEY", value: "sk_live_x", updated_at: "2026-01-01" } as never,
      { name: "NO_VALUE" } as never,
      { value: "no name" } as never,
      { name: "SENDGRID", value: "SG.abc" },
    ]);
    expect(out).toEqual([
      { name: "STRIPE_KEY", value: "sk_live_x" },
      { name: "SENDGRID", value: "SG.abc" },
    ]);
  });
  test("empty input → empty array", () => {
    expect(toProjectSecrets([])).toEqual([]);
  });
});

describe("planThirdPartyAuth", () => {
  const src: ThirdPartyAuth[] = [
    { id: "1", type: "oidc", oidc_issuer_url: "https://firebase/x" },
    { id: "2", type: "oidc", jwks_url: "https://auth0/jwks" },
  ];
  test("posts source integrations missing on target; drops id/type/resolved", () => {
    const plan = planThirdPartyAuth(src, []);
    expect(plan).toEqual([
      { oidc_issuer_url: "https://firebase/x" },
      { jwks_url: "https://auth0/jwks" },
    ]);
  });
  test("dedupes against existing target by issuer/jwks key", () => {
    const plan = planThirdPartyAuth(src, [{ oidc_issuer_url: "https://firebase/x" }]);
    expect(plan).toEqual([{ jwks_url: "https://auth0/jwks" }]);
  });
  test("keeps custom_jwks when present, skips keyless entries", () => {
    const plan = planThirdPartyAuth(
      [{ jwks_url: "https://j", custom_jwks: { keys: [] } }, { type: "broken" }],
      [],
    );
    expect(plan).toEqual([{ jwks_url: "https://j", custom_jwks: { keys: [] } }]);
  });
  test("tpaKey prefers issuer over jwks", () => {
    expect(tpaKey({ oidc_issuer_url: "a", jwks_url: "b" })).toBe("a");
    expect(tpaKey({ jwks_url: "b" })).toBe("b");
    expect(tpaKey({})).toBe("");
  });
});

describe("planSsoProviders", () => {
  const src: SamlProvider[] = [
    {
      id: "p1",
      saml: {
        entity_id: "https://idp/saml",
        metadata_url: "https://idp/meta",
        attribute_mapping: { keys: { email: { name: "mail" } } },
        name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      },
      domains: [{ domain: "acme.com" }, { domain: "acme.io" }],
    },
  ];
  test("builds POST body from saml fields + maps domains to string[]", () => {
    const plan = planSsoProviders(src, []);
    expect(plan).toEqual([
      {
        type: "saml",
        metadata_url: "https://idp/meta",
        domains: ["acme.com", "acme.io"],
        attribute_mapping: { keys: { email: { name: "mail" } } },
        name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      },
    ]);
  });
  test("dedupes by entity_id", () => {
    expect(planSsoProviders(src, [{ saml: { entity_id: "https://idp/saml" } }])).toEqual([]);
  });
  test("prefers metadata_url over metadata_xml", () => {
    const plan = planSsoProviders(
      [{ saml: { entity_id: "e", metadata_url: "u", metadata_xml: "<xml/>" } }],
      [],
    );
    expect(plan[0]?.metadata_url).toBe("u");
    expect(plan[0]).not.toHaveProperty("metadata_xml");
  });
  test("falls back to metadata_xml when no url", () => {
    const plan = planSsoProviders([{ saml: { entity_id: "e", metadata_xml: "<xml/>" } }], []);
    expect(plan[0]?.metadata_xml).toBe("<xml/>");
  });
  test("skips providers with no entity_id", () => {
    expect(planSsoProviders([{ saml: {} }, {}], [])).toEqual([]);
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
