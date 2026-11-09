import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createHttpServer, resolveHttpBindHost } from "../http-server.js";
import { HealthCheck } from "../health-check.js";
import { extJsonParse } from "../../json/ext-json.js";
import type { Server } from "http";
import type { HealthCheckPort } from "../../ports/health-check-port.js";

async function fetchUrl(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body };
}

describe("HttpServer", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Find a free port by binding to 0
    port = 0;
    const dbPing: HealthCheckPort = { ping: vi.fn(async () => true) };
    const healthCheck = new HealthCheck(dbPing);
    server = await createHttpServer({ port, healthCheck, serviceName: "test" });
    const addr = server.address();
    if (addr && typeof addr === "object") port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /health returns 200 with healthy status when DB ping succeeds", async () => {
    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/health`);
    expect(status).toBe(200);
    const json = extJsonParse(body) as { ok: boolean; service: string; checks: { db: { ok: boolean } } };
    expect(json.ok).toBe(true);
    expect(json.service).toBe("test");
    expect(json.checks.db.ok).toBe(true);
  });

  it("GET /unknown returns 404", async () => {
    const { status } = await fetchUrl(`http://127.0.0.1:${port}/unknown`);
    expect(status).toBe(404);
  });
});

describe("HttpServer without healthCheck", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = await createHttpServer({ port: 0 });
    const addr = server.address();
    if (addr && typeof addr === "object") port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /health returns 200 with healthy status (no checks)", async () => {
    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/health`);
    expect(status).toBe(200);
    const json = extJsonParse(body) as { ok: boolean; service: string; checks: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.service).toBe("microservice");
  });
});

describe("HealthCheck", () => {
  it("checkDb returns ok:true when ping succeeds", async () => {
    const dbPing: HealthCheckPort = { ping: vi.fn(async () => true) };
    const hc = new HealthCheck(dbPing);
    const result = await hc.checkDb();
    expect(result.ok).toBe(true);
  });

  it("checkDb returns ok:false when ping throws", async () => {
    const dbPing: HealthCheckPort = { ping: vi.fn(async () => { throw new Error("down"); }) };
    const hc = new HealthCheck(dbPing);
    const result = await hc.checkDb();
    expect(result.ok).toBe(false);
  });

  it("runAll includes db + custom checks", async () => {
    const dbPing: HealthCheckPort = { ping: vi.fn(async () => true) };
    const hc = new HealthCheck(dbPing, {
      nats: async () => ({ ok: true, detail: "connected" }),
      broken: async () => { throw new Error("nope"); },
    });
    const results = await hc.runAll();
    expect(results.db.ok).toBe(true);
    expect(results.nats.ok).toBe(true);
    expect(results.broken.ok).toBe(false);
    expect((results.broken as { error?: string }).error).toBe("nope");
  });

  it("isHealthy returns true only when all checks are ok", async () => {
    const dbPing: HealthCheckPort = { ping: vi.fn(async () => true) };
    const hc = new HealthCheck(dbPing, { bad: async () => ({ ok: false }) });
    const results = await hc.runAll();
    expect(hc.isHealthy(results)).toBe(false);
  });
});

describe("resolveHttpBindHost", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  it("defaults to 127.0.0.1 outside production", () => {
    delete process.env.NODE_ENV;
    expect(resolveHttpBindHost(null)).toBe("127.0.0.1");
  });

  it("defaults to 0.0.0.0 under NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    expect(resolveHttpBindHost(null)).toBe("0.0.0.0");
  });

  it("an explicit config value wins in every environment", () => {
    delete process.env.NODE_ENV;
    expect(resolveHttpBindHost("::1")).toBe("::1");
    process.env.NODE_ENV = "production";
    expect(resolveHttpBindHost("::")).toBe("::");
    expect(resolveHttpBindHost("10.0.0.5")).toBe("10.0.0.5");
  });
});

describe("HttpServer bind host", () => {
  it("binds IPv4 loopback by default — IPv6 loopback stays unreachable", async () => {
    const server = await createHttpServer({ port: 0 });
    try {
      const addr = server.address();
      expect(addr && typeof addr === "object" ? addr.address : addr).toBe("127.0.0.1");
      const port = (addr as { port: number }).port;
      const { status } = await fetchUrl(`http://127.0.0.1:${port}/health`);
      expect(status).toBe(200);
      await expect(fetchUrl(`http://[::1]:${port}/health`)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("binds IPv6 loopback when hostname is ::1 — IPv4 stays unreachable", async () => {
    const server = await createHttpServer({ port: 0, hostname: "::1" });
    try {
      const addr = server.address();
      expect(addr && typeof addr === "object" ? addr.address : addr).toBe("::1");
      const port = (addr as { port: number }).port;
      const { status } = await fetchUrl(`http://[::1]:${port}/health`);
      expect(status).toBe(200);
      await expect(fetchUrl(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
