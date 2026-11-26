/**
 * Server-level provenance enforcement — the wiring proof: enforce mode
 * rejects unsigned, accepts signed, verify-if-present passes plain traffic
 * but rejects cleartext identity injection.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageKeyProvider, setMessageKeyProvider } from "../../nats/message-key-provider.js";
import { resetHttpSigningForTest, signInternalRequest } from "../../auth/http-signing.js";
import { resetNonceCacheForTest } from "../../auth/nonce-cache.js";
import { createHttpServer } from "../http-server.js";
import type { Server } from "node:http";

async function readyProvider(): Promise<MessageKeyProvider> {
  const provider = new MessageKeyProvider(async () => ({ generation: 7, generations: { "7": "test-partb-material" } }));
  await provider.refresh();
  return provider;
}

async function bootServer(mode: "enforce" | "verify-if-present"): Promise<{ server: Server; port: number }> {
  const server = await createHttpServer({
    port: 0,
    internalProvenance: mode,
    routeHandler: async (req, res) => {
      if (req.url?.startsWith("/api/v1/test")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, user: req.headers["x-user-id"] ?? null, bodyLen: Buffer.concat(chunks).length }));
        return true;
      }
      return false;
    },
  });
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe("http-server provenance enforcement", () => {
  let server: Server | undefined;
  beforeEach(async () => {
    setMessageKeyProvider(await readyProvider());
    resetHttpSigningForTest();
    resetNonceCacheForTest();
  });
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  it("enforce: unsigned internal request rejected 401 AUTH_SIGNATURE_MISSING", async () => {
    ({ server } = await bootServer("enforce"));
    const port = (server!.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/test`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const body = await res.json() as { internal_code: string };
    expect(body.internal_code).toBe("AUTH_SIGNATURE_MISSING");
  });

  it("enforce: signed request passes, unsealed identity visible downstream, body re-armed", async () => {
    ({ server } = await bootServer("enforce"));
    const port = (server!.address() as { port: number }).port;
    const payload = JSON.stringify({ probe: 1 });
    const signed = signInternalRequest({
      service: "backend",
      method: "POST",
      path: "/api/v1/test",
      body: payload,
      sensitiveHeaders: { "x-user-id": "u-9" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/test`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { user: string; bodyLen: number };
    expect(body.user).toBe("u-9");
    expect(body.bodyLen).toBe(payload.length);
  });

  it("verify-if-present: cleartext x-user injection without signature is rejected", async () => {
    ({ server } = await bootServer("verify-if-present"));
    const port = (server!.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/test`, {
      method: "POST",
      headers: { "x-user-id": "attacker", "x-user-is-admin": "true" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("verify-if-present: plain public traffic passes unsigned", async () => {
    ({ server } = await bootServer("verify-if-present"));
    const port = (server!.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/test`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
  });

  it("cleartext x-user riding a valid signature is stripped — never reaches downstream", async () => {
    ({ server } = await bootServer("enforce"));
    const port = (server!.address() as { port: number }).port;
    const payload = "{}";
    const signed = signInternalRequest({
      service: "backend",
      method: "POST",
      path: "/api/v1/test",
      body: payload,
      sensitiveHeaders: {},
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/test`, {
      method: "POST",
      headers: { ...signed, "x-user-id": "injected", "content-type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { user: string | null };
    expect(body.user).toBeNull();
  });
});
