/**
 * internalFetch signing funnel — every outbound internal HTTP call carries
 * the proof-of-possession signature; sensitive headers never travel cleartext.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { internalFetch, configureInternalClient, resetInternalClient } from "../internal-client.js";
import { MessageKeyProvider, setMessageKeyProvider } from "../../nats/message-key-provider.js";
import { resetHttpSigningForTest, verifyInternalRequest, SIGNING_HEADERS } from "../../auth/http-signing.js";
import { setCurrentServiceCode } from "../../service/service-identity.js";

async function readyProvider(): Promise<MessageKeyProvider> {
  const provider = new MessageKeyProvider(async () => ({
    generation: 7,
    generations: { "7": "test-partb-material" },
  }));
  await provider.refresh();
  return provider;
}

describe("internalFetch signing", () => {
  let server: Server;
  let captured: { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; body: string } = { headers: {} };

  beforeEach(async () => {
    setMessageKeyProvider(await readyProvider());
    resetHttpSigningForTest();
    configureInternalClient(() => ({ "user-agent": "primebrick-test/1.0 (test)" }));
    captured = { headers: {} };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        captured = { method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString() };
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });

  afterEach(async () => {
    resetInternalClient();
    await new Promise((r) => server.close(r));
  });

  function port(): number {
    return (server.address() as { port: number }).port;
  }

  it("signs every outbound call — x-pb-* headers present, valid against the received bytes", async () => {
    const body = JSON.stringify({ hello: "world" });
    await internalFetch(`http://127.0.0.1:${port()}/api/v1/entities/customer?limit=1`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    for (const h of [SIGNING_HEADERS.service, SIGNING_HEADERS.keygen, SIGNING_HEADERS.timestamp, SIGNING_HEADERS.nonce, SIGNING_HEADERS.signature]) {
      expect(captured.headers[h], `missing ${h}`).toBeTruthy();
    }
    // the verifier recomputes over the EXACT received bytes — the wire truth
    const provenance = await verifyInternalRequest({
      method: captured.method!,
      path: captured.url!,
      body: captured.body,
      getHeader: (name) => captured.headers[name.toLowerCase()] as string | undefined,
    });
    expect(provenance.service).toBeTruthy();
  });

  it("x-user-* never travels cleartext — sealed in the blob, opened intact", async () => {
    await internalFetch(`http://127.0.0.1:${port()}/api/v1/x`, {
      method: "POST",
      body: "{}",
      headers: { "x-user-id": "u-42", "x-user-is-admin": "true", "content-type": "application/json" },
    });
    expect(captured.headers["x-user-id"]).toBeUndefined();
    expect(captured.headers["x-user-is-admin"]).toBeUndefined();
    expect(captured.headers[SIGNING_HEADERS.sealed]).toBeTruthy();
    const provenance = await verifyInternalRequest({
      method: captured.method!,
      path: captured.url!,
      body: captured.body,
      getHeader: (name) => captured.headers[name.toLowerCase()] as string | undefined,
    });
    expect(provenance.sensitiveHeaders["x-user-id"]).toBe("u-42");
    expect(provenance.sensitiveHeaders["x-user-is-admin"]).toBe("true");
  });

  it("unsigned callers explode — fail-closed without key material", async () => {
    setMessageKeyProvider(null);
    resetHttpSigningForTest();
    await expect(internalFetch(`http://127.0.0.1:${port()}/api/v1/x`)).rejects.toThrow("AUTH_SIGNING_KEY_UNAVAILABLE");
  });
});
