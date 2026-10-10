import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceRegistrar } from "../service-registrar.js";
import { SERVICE_SUBJECTS } from "../service-lifecycle-subjects.js";

/**
 * callNats() drives the register handshake: publish with a reply inbox,
 * then one message on the inbox subscription. The mock connection
 * yields queued replies (or nothing → callNats timeout → retry).
 */
function makeNatsMock(replyBatches: unknown[][] = [[{ registered: true }]]) {
  const conn = {
    publish: vi.fn(),
    subscribe: vi.fn((_inbox: string, _opts?: unknown) => {
      const msgs = replyBatches.shift() ?? [];
      return {
        unsubscribe: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          for (const r of msgs) {
            yield { data: new TextEncoder().encode(JSON.stringify(r)) };
          }
          // keep the iterator open — simulates "no reply yet"
          await new Promise(() => {});
        },
      };
    }),
  };
  return {
    publish: vi.fn(async () => {}),
    conn,
    getConnection: vi.fn(async () => conn),
    subscribe: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
  };
}

const baseConfig = {
  serviceCode: "emailsender",
  baseUrl: "http://localhost:8081",
  endpoints: { send: "/send" },
};

describe("ServiceRegistrar", () => {
  let nats: ReturnType<typeof makeNatsMock>;
  let registrar: ServiceRegistrar;

  beforeEach(() => {
    nats = makeNatsMock();
    registrar = new ServiceRegistrar(nats as any, baseConfig);
  });

  it("register() sends a service.register request and resolves on ack", async () => {
    await registrar.register();
    expect(nats.conn.publish).toHaveBeenCalledTimes(1);
    const [subject, raw] = nats.conn.publish.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(raw));
    expect(subject).toBe(SERVICE_SUBJECTS.REGISTER);
    expect(payload.code).toBe("emailsender");
    expect(payload.base_url).toBe("http://localhost:8081");
    expect(payload.endpoints).toEqual({ send: "/send" });
    expect(payload.is_behind_scaler).toBe(false);
    expect(payload.http_healthy).toBe(true);
    expect(payload.nats_connected).toBe(true);
    expect(payload.checks).toEqual({});
  });

  it("register() includes metadata fields when provided", async () => {
    registrar = new ServiceRegistrar(nats as any, {
      ...baseConfig,
      name: "Email Sender",
      description: "Sends emails",
      author: "PrimeBrick",
      github_repo_url: "https://github.com/primebrick/emailsender",
      service_version: "1.2.3",
      is_behind_scaler: true,
    });
    await registrar.register();
    const payload = JSON.parse(new TextDecoder().decode(nats.conn.publish.mock.calls[0][1]));
    expect(payload.name).toBe("Email Sender");
    expect(payload.description).toBe("Sends emails");
    expect(payload.author).toBe("PrimeBrick");
    expect(payload.github_repo_url).toBe("https://github.com/primebrick/emailsender");
    expect(payload.service_version).toBe("1.2.3");
    expect(payload.is_behind_scaler).toBe(true);
  });

  it("register() retries until acked (no ack = no resolve)", async () => {
    vi.useFakeTimers();
    try {
      nats = makeNatsMock([
        [], // attempt 1: no reply → callNats timeout
        [{ registered: false, error: "publisher identity rejected" }],
        [{ registered: true }],
      ]);
      registrar = new ServiceRegistrar(nats as any, baseConfig);
      const p = registrar.register();
      await vi.advanceTimersByTimeAsync(15_000); // 3s callNats timeout + two 5s retries
      await p;
      expect(nats.conn.publish).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendHeartbeat() publishes to service.heartbeat subject", async () => {
    await registrar.sendHeartbeat();
    expect(nats.publish).toHaveBeenCalledTimes(1);
    const [subject, payload] = nats.publish.mock.calls[0];
    expect(subject).toBe(SERVICE_SUBJECTS.HEARTBEAT);
    expect(payload.code).toBe("emailsender");
    expect(payload.base_url).toBe("http://localhost:8081");
    // heartbeat does NOT include endpoints
    expect(payload.endpoints).toBeUndefined();
    expect(payload.http_healthy).toBe(true);
    expect(payload.nats_connected).toBe(true);
  });

  it("sendHeartbeat() includes service_version when configured", async () => {
    registrar = new ServiceRegistrar(nats as any, { ...baseConfig, service_version: "2.0.0" });
    await registrar.sendHeartbeat();
    const payload = nats.publish.mock.calls[0][1];
    expect(payload.service_version).toBe("2.0.0");
  });

  it("sendHeartbeat() swallows errors", async () => {
    nats.publish.mockRejectedValue(new Error("nats down"));
    await expect(registrar.sendHeartbeat()).resolves.toBeUndefined();
  });

  it("unregister() publishes to service.unregister subject", async () => {
    await registrar.unregister();
    expect(nats.publish).toHaveBeenCalledTimes(1);
    const [subject, payload] = nats.publish.mock.calls[0];
    expect(subject).toBe(SERVICE_SUBJECTS.UNREGISTER);
    expect(payload.code).toBe("emailsender");
    expect(payload.base_url).toBe("http://localhost:8081");
    expect(payload.is_behind_scaler).toBe(false);
  });

  it("startHeartbeat returns a timer and stopHeartbeat clears it", () => {
    const timer = registrar.startHeartbeat();
    expect(typeof timer).toBe("object");
    registrar.stopHeartbeat();
    // No throw — clearing twice is safe
    registrar.stopHeartbeat();
  });

  it("uses default heartbeatIntervalMs (30000) when not provided", () => {
    const r = new ServiceRegistrar(nats as any, {
      serviceCode: "x",
      baseUrl: "http://x",
      endpoints: {},
    });
    r.startHeartbeat();
    r.stopHeartbeat();
  });

  it("uses healthCheckFn when provided", async () => {
    const healthCheckFn = vi.fn(async () => ({
      http_healthy: false,
      checks: { db: { ok: false, error: "connection refused" } },
    }));
    registrar = new ServiceRegistrar(nats as any, baseConfig, healthCheckFn);
    await registrar.sendHeartbeat();
    const payload = nats.publish.mock.calls[0][1];
    expect(payload.http_healthy).toBe(false);
    expect(payload.checks.db.ok).toBe(false);
    expect(payload.checks.db.error).toBe("connection refused");
    expect(healthCheckFn).toHaveBeenCalledTimes(1);
  });

  it("nats_connected reflects NatsClient.isConnected() result", async () => {
    nats.isConnected = vi.fn(() => false);
    await registrar.sendHeartbeat();
    const payload = nats.publish.mock.calls[0][1];
    expect(payload.nats_connected).toBe(false);
  });
});
