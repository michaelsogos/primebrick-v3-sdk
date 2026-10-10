import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageIdentity,
  buildUserAgent,
  identityHeaders,
  verifyClientIdentity,
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
