import { beforeEach, describe, expect, it } from "vitest";
import { extJsonStringify, extJsonParse } from "../../json/ext-json.js";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { MessageKeyProvider, setMessageKeyProvider } from "../../nats/message-key-provider.js";
import { resetHttpSigningForTest, signInternalRequest } from "../http-signing.js";
import { verifyEdgeRequest } from "../edge-verification.js";
import { resetNonceCacheForTest } from "../nonce-cache.js";

async function readyProvider(): Promise<MessageKeyProvider> {
  const provider = new MessageKeyProvider(async () => ({ generation: 7, generations: { "7": "test-partb-material" } }));
  await provider.refresh();
  return provider;
}

describe("edge-verification", () => {
  let server: Server;

  beforeEach(async () => {
    setMessageKeyProvider(await readyProvider());
    resetHttpSigningForTest();
    resetNonceCacheForTest();
  });

  async function withServer(handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void, fn: (port: number) => Promise<void>) {
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      await fn((server.address() as { port: number }).port);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it("verifies a signed request, unseals identity into headers, exposes exact body", async () => {
    const payload = extJsonStringify({ test: true });
    await withServer(
      async (req, res) => {
        try {
          const url = new URL(req.url!, "http://x");
          const verified = await verifyEdgeRequest(req, url);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(extJsonStringify({
            service: verified.provenance.service,
            user: req.headers["x-user-id"],
            bodyLen: verified.body.length,
          }));
        } catch (e) {
          res.writeHead(401);
          res.end(extJsonStringify({ error: (e as Error).message }));
        }
      },
      async (port) => {
        const signed = signInternalRequest({
          service: "backend",
          method: "POST",
          path: "/api/v1/x?y=1",
          body: payload,
          sensitiveHeaders: { "x-user-id": "u-7" },
        });
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/x?y=1`, {
          method: "POST",
          headers: { "content-type": "application/json", ...signed },
          body: payload,
        });
        const data = extJsonParse(await res.text()) as { service: string; user: string; bodyLen: number };
        expect(res.status).toBe(200);
        expect(data.service).toBe("backend");
        expect(data.user).toBe("u-7");
        expect(data.bodyLen).toBe(BigInt(payload.length));
      },
    );
  });

  it("an unsigned request is rejected at the edge", async () => {
    await withServer(
      async (req, res) => {
        try {
          await verifyEdgeRequest(req, new URL(req.url!, "http://x"));
          res.writeHead(200);
          res.end("{}");
        } catch {
          res.writeHead(401);
          res.end("{}");
        }
      },
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/x`, { method: "POST", body: "{}" });
        expect(res.status).toBe(401);
      },
    );
  });
});
