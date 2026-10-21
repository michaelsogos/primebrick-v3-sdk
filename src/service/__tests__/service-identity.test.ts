import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageIdentity,
  resolveServiceCode,
  buildUserAgent,
  identityHeaders,
  verifyClientIdentity,
  deriveClientKey,
  clientKeyHash,
  verifyRowKey,
  CLIENT_SHIELD_KEY_HEADER,
} from "../service-identity.js";

function headersReq(h: Record<string, string>) {
  return { headers: { get: (n: string) => h[n.toLowerCase()] ?? null } };
}

describe("detectPackageIdentity", () => {
  it("reads name/version from package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "primebrick-emailsender", version: "1.4.0" }));
    expect(detectPackageIdentity(dir)).toEqual({ name: "primebrick-emailsender", version: "1.4.0" });
  });

  it("falls back to 'app' without package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-"));
    expect(detectPackageIdentity(dir)).toEqual({ name: "app", version: undefined });
  });
});

describe("resolveServiceCode", () => {
  it("derives code from primebrick-<code> package name", () => {
    expect(resolveServiceCode({ name: "primebrick-job" })).toBe("job");
    expect(resolveServiceCode({ name: "primebrick-emailsender" })).toBe("emailsender");
  });

  it("package.json service_code override wins over the name derivation", () => {
    expect(resolveServiceCode({ name: "primebrick-job-handler", service_code: "job" })).toBe("job");
  });

  it("non-prefixed package name derives to the full name", () => {
    expect(resolveServiceCode({ name: "crm_playground" })).toBe("crm_playground");
  });

  it("rejects invalid derived codes (must declare an explicit override)", () => {
    expect(() => resolveServiceCode({ name: "primebrick-job-handler" })).toThrow("Invalid service_code");
    expect(() => resolveServiceCode({ name: "app" })).not.toThrow(); // "app" is a valid code
  });

  it("matching config row passes silently", () => {
    expect(resolveServiceCode({ name: "primebrick-job" }, "job")).toBe("job");
  });

  it("config drift trips loudly — a runtime-edited service_code never wins", () => {
    expect(() => resolveServiceCode({ name: "primebrick-job" }, "scheduler")).toThrow("service_code config drift");
    expect(() => resolveServiceCode({ name: "primebrick-job-handler", service_code: "job" }, "scheduler")).toThrow(
      "service_code config drift",
    );
  });
});

describe("buildUserAgent", () => {
  it("formats pkg/version (capabilities) runtime/ver", () => {
    const ua = buildUserAgent({ name: "primebrick-emailsender", version: "1.4.0" }, "emailsender");
    expect(ua).toMatch(/^primebrick-emailsender\/1\.4\.0 \(emailsender\) (Node|Bun)\/\d+/);
  });
});

describe("identityHeaders", () => {
  it("emits UA + client key header", () => {
    const h = identityHeaders({ name: "svc", version: "1.0.0" }, "svc", "secret-key");
    expect(h[CLIENT_SHIELD_KEY_HEADER]).toBe("secret-key");
    expect(h["User-Agent"]).toContain("svc/1.0.0 (svc)");
  });
});

describe("verifyClientIdentity", () => {
  const opts = {
    allowedPrefixes: ["primebrick-emailsender/", "postman-runtime/"],
    verifyKey: async () => true,
  };

  it("401 when UA missing", async () => {
    const r = await verifyClientIdentity(headersReq({}), opts);
    expect(r).toEqual({ ok: false, status: 401, error: "UNIDENTIFIED_CLIENT" });
  });

  it("403 when UA not in allowlist", async () => {
    const r = await verifyClientIdentity(headersReq({ "user-agent": "curl/8.0" }), opts);
    expect(r).toEqual({ ok: false, status: 403, error: "UNKNOWN_CLIENT" });
  });

  it("401 when client key missing", async () => {
    const r = await verifyClientIdentity(
      headersReq({ "user-agent": "primebrick-emailsender/1.4.0 (emailsender) Node/24" }),
      opts
    );
    expect(r).toEqual({ ok: false, status: 401, error: "INVALID_CLIENT_SHIELD_KEY" });
  });

  it("401 when client key invalid", async () => {
    const r = await verifyClientIdentity(
      headersReq({ "user-agent": "primebrick-emailsender/1.4.0", [CLIENT_SHIELD_KEY_HEADER]: "bad" }),
      { ...opts, verifyKey: async () => false }
    );
    expect(r).toEqual({ ok: false, status: 401, error: "INVALID_CLIENT_SHIELD_KEY" });
  });

  it("ok when UA prefix matches and key verifies", async () => {
    const r = await verifyClientIdentity(
      headersReq({ "user-agent": "primebrick-emailsender/1.4.0 (emailsender) Bun/1.2", [CLIENT_SHIELD_KEY_HEADER]: "good" }),
      opts
    );
    expect(r).toEqual({ ok: true, ua: "primebrick-emailsender/1.4.0 (emailsender) Bun/1.2" });
  });

  it("manual entry (postman) works the same way", async () => {
    const r = await verifyClientIdentity(
      headersReq({ "user-agent": "postman-runtime/7.40", [CLIENT_SHIELD_KEY_HEADER]: "k" }),
      opts
    );
    expect(r.ok).toBe(true);
  });
});

describe("deriveClientKey (B14)", () => {
  const secret = "test-derivation-secret";
  const prefix = "primebrick-ai/3.1.0";

  it("is deterministic for the same (secret, prefix, generation)", () => {
    expect(deriveClientKey(secret, prefix, 3)).toBe(deriveClientKey(secret, prefix, 3));
  });

  it("changes with generation — a rotation produces a different key", () => {
    expect(deriveClientKey(secret, prefix, 3)).not.toBe(deriveClientKey(secret, prefix, 4));
  });

  it("changes with prefix — per-service key material", () => {
    expect(deriveClientKey(secret, prefix, 0)).not.toBe(deriveClientKey(secret, "primebrick-other/1.0.0", 0));
  });

  it("changes with secret — knowledge of the secret is required", () => {
    expect(deriveClientKey(secret, prefix, 0)).not.toBe(deriveClientKey("other-secret", prefix, 0));
  });

  it("produces base64url without padding-unsafe characters", () => {
    expect(deriveClientKey(secret, prefix, 1)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("verifyRowKey (B14 grace window)", () => {
  const current = clientKeyHash("key-v2");
  const previous = clientKeyHash("key-v1");
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 1_000);

  it("accepts the current hash", () => {
    expect(verifyRowKey({ client_key_hash: current }, "key-v2")).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(verifyRowKey({ client_key_hash: current }, "key-v3")).toBe(false);
  });

  it("accepts the previous hash inside the grace window", () => {
    expect(
      verifyRowKey({ client_key_hash: current, previous_key_hash: previous, previous_valid_until: future }, "key-v1"),
    ).toBe(true);
  });

  it("rejects the previous hash after the grace window", () => {
    expect(
      verifyRowKey({ client_key_hash: current, previous_key_hash: previous, previous_valid_until: past }, "key-v1"),
    ).toBe(false);
  });

  it("rejects the previous hash when no grace deadline is set", () => {
    expect(verifyRowKey({ client_key_hash: current, previous_key_hash: previous }, "key-v1")).toBe(false);
  });

  it("accepts ISO-string grace deadlines (wire shape)", () => {
    expect(
      verifyRowKey(
        { client_key_hash: current, previous_key_hash: previous, previous_valid_until: future.toISOString() },
        "key-v1",
      ),
    ).toBe(true);
  });

  it("rejects on a missing row", () => {
    expect(verifyRowKey(undefined, "key-v2")).toBe(false);
  });
});
