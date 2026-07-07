import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigLoader } from "../config-loader.js";
import type { ConfigRepositoryPort } from "../../ports/config-repository-port.js";

function makeRepo(rows: Array<{ key: string; value: string | null }>): ConfigRepositoryPort {
  return {
    findAll: vi.fn(async () => rows),
  };
}

describe("ConfigLoader", () => {
  let loader: ConfigLoader;

  beforeEach(() => {
    loader = new ConfigLoader(makeRepo([
      { key: "brevo_api_key", value: "x-key" },
      { key: "feature_x", value: null },
      { key: "port", value: "8080" },
    ]));
  });

  it("load() populates cache and returns a record", async () => {
    const all = await loader.load();
    expect(all).toEqual({
      brevo_api_key: "x-key",
      feature_x: null,
      port: "8080",
    });
  });

  it("get() returns value from cache after load()", async () => {
    await loader.load();
    expect(loader.get("brevo_api_key")).toBe("x-key");
    expect(loader.get("feature_x")).toBeNull();
    expect(loader.get("missing_key")).toBeNull();
  });

  it("get() throws before load()", () => {
    expect(() => loader.get("any")).toThrow(/must be called before get/);
  });

  it("require() throws on missing or empty value", async () => {
    await loader.load();
    expect(loader.require("brevo_api_key")).toBe("x-key");
    expect(() => loader.require("feature_x")).toThrow(/Missing required config key: feature_x/);
    expect(() => loader.require("missing_key")).toThrow(/Missing required config key: missing_key/);
  });

  it("getTyped() converts via converter, returns null on missing", async () => {
    await loader.load();
    expect(loader.getTyped("port", Number)).toBe(8080);
    expect(loader.getTyped("missing", Number)).toBeNull();
  });

  it("requireTyped() converts and throws on missing", async () => {
    await loader.load();
    expect(loader.requireTyped("port", Number)).toBe(8080);
    expect(() => loader.requireTyped("missing", Number)).toThrow(/Missing required config key/);
  });

  it("getAll() returns the full cache", async () => {
    await loader.load();
    expect(loader.getAll()).toEqual({
      brevo_api_key: "x-key",
      feature_x: null,
      port: "8080",
    });
  });

  it("invalidate() clears cache so next get() throws", async () => {
    await loader.load();
    loader.invalidate();
    expect(() => loader.get("brevo_api_key")).toThrow(/must be called before get/);
  });

  it("load() can be called again after invalidate()", async () => {
    await loader.load();
    loader.invalidate();
    const all = await loader.load();
    expect(all["brevo_api_key"]).toBe("x-key");
  });
});
