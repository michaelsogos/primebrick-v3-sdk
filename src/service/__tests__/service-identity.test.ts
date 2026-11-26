import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPackageIdentity, resolveServiceCode, buildUserAgent } from "../service-identity.js";
import { extJsonStringify } from "../../json/ext-json.js";

describe("detectPackageIdentity", () => {
  it("reads name/version from package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-"));
    writeFileSync(join(dir, "package.json"), extJsonStringify({ name: "primebrick-emailsender", version: "1.4.0" }));
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
