import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { internalFetch, configureInternalClient, resetInternalClient } from "../internal-client.js";

describe("internalFetch", () => {
  beforeEach(() => resetInternalClient());
  afterEach(() => vi.unstubAllGlobals());

  it("throws fail-closed when not configured", async () => {
    await expect(internalFetch("http://x/health")).rejects.toThrow("not configured");
  });

  it("injects identity headers and lets caller headers coexist", async () => {
    configureInternalClient(() => ({
      "User-Agent": "primebrick-api/0.33.0 (backend) Node/24.0.0",
      "x-primebrick-client-shield-key": "k1",
    }));
    const spy = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", spy);

    await internalFetch("http://us/api", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    });

    const sent = spy.mock.calls[0][1].headers as Headers;
    expect(sent.get("user-agent")).toBe("primebrick-api/0.33.0 (backend) Node/24.0.0");
    expect(sent.get("x-primebrick-client-shield-key")).toBe("k1");
    expect(sent.get("authorization")).toBe("Bearer t");
    expect(sent.get("content-type")).toBe("application/json");
  });

  it("identity headers cannot be overridden by the caller", async () => {
    configureInternalClient(() => ({
      "User-Agent": "primebrick-api/0.33.0 (backend) Node/24.0.0",
      "x-primebrick-client-shield-key": "k1",
    }));
    const spy = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", spy);

    await internalFetch("http://us/api", {
      headers: { "User-Agent": "evil/1.0", "x-primebrick-client-shield-key": "spoofed" },
    });

    const sent = spy.mock.calls[0][1].headers as Headers;
    expect(sent.get("user-agent")).toBe("primebrick-api/0.33.0 (backend) Node/24.0.0");
    expect(sent.get("x-primebrick-client-shield-key")).toBe("k1");
  });
});
