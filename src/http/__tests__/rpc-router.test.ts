import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeRpcRouter, composeRouteHandlers, type RouteHandler } from "../rpc-router.js";
import { initAuthConfig, loadAuthConfig } from "../../auth/auth-config-cache.js";
import { serializeAuthUserToHeaders } from "../../auth/auth-user-serializer.js";
import { AuthMode, type AuthConfig, type AuthUser } from "../../auth/types.js";
import type { ApiKeyPort, ApiKeyRecord } from "../../auth/ports/api-key-port.js";

const CFG: AuthConfig = {
  mode: AuthMode.GATEWAY,
  roles_path: "roles",
  oidc: {},
  gateway: {
    secret: "test-secret",
    secret_header_name: "x-gateway-secret",
    headers: {},
  },
  enable_email_verification_check: false,
  enable_webauthn: false,
  passkey_required: false,
  enable_mfa: false,
};

function userHeaders(perms: string[], secret = "test-secret") {
  const user: AuthUser = {
    id: "u-1",
    idp_code: "casdoor/alice",
    email: "a@b.c",
    name: "Alice",
    roles: [],
    permissions: new Set(perms),
    isAdmin: false,
    isSystem: false,
    idp_org: null,
    idp_username: null,
  };
  return serializeAuthUserToHeaders(user, CFG);
}

let server: Server;
let base: string;
let handler: RouteHandler = async () => false;

async function call(path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, init);
}

beforeAll(async () => {
  initAuthConfig({ load: async () => CFG });
  await loadAuthConfig();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void handler(req, res, url).then((handled) => {
      if (!handled) { res.writeHead(404).end(); }
    }).catch((e) => { res.writeHead(500).end(String(e)); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("makeRpcRouter — construction enforcement", () => {
  it("rejects a non-public route without permissions", () => {
    expect(() =>
      makeRpcRouter([{ method: "GET", path: "/x", handler: async () => ({}) }]),
    ).toThrow(/no permissions/);
  });

  it("rejects api_key auth without an apiKeyPort", () => {
    expect(() =>
      makeRpcRouter(
        [{ method: "GET", path: "/x", auth: "api_key", permissions: ["p"], handler: async () => ({}) }],
      ),
    ).toThrow(/apiKeyPort/);
  });

  it("allows a public route without permissions", () => {
    expect(() =>
      makeRpcRouter([{ method: "GET", path: "/x", auth: "public", handler: async () => ({}) }]),
    ).not.toThrow();
  });
});

describe("makeRpcRouter — request pipeline", () => {
  const okHandler = async () => ({ ok: true });
  const router = makeRpcRouter([
    { method: "GET", path: "/secure", permissions: ["test.read"], handler: okHandler },
    { method: "POST", path: "/echo", permissions: ["test.write"], body: (b) => b, handler: async ({ body }) => body },
    { method: "POST", path: "/strict", permissions: ["test.write"], body: () => { throw new Error("bad body"); }, handler: okHandler },
    { method: "GET", path: "/items/:uuid", permissions: ["test.read"], handler: async ({ params }) => ({ uuid: params["uuid"] }) },
    { method: "GET", path: "/open", auth: "public", handler: okHandler },
  ]);

  it("returns false for unmatched paths (chainable)", async () => {
    handler = router;
    const res = await call("/nope");
    expect(res.status).toBe(404);
  });

  it("405 on wrong method", async () => {
    const res = await call("/secure", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("401 without gateway secret", async () => {
    const res = await call("/secure");
    expect(res.status).toBe(401);
  });

  it("403 with valid auth but missing permission", async () => {
    const res = await call("/secure", { headers: userHeaders(["other.perm"]) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.internal_code).toBe("RBAC_PERMISSION_DENIED");
  });

  it("200 with valid auth + permission", async () => {
    const res = await call("/secure", { headers: userHeaders(["test.read"]) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("extracts :param path params", async () => {
    const res = await call("/items/abc-123", { headers: userHeaders(["test.read"]) });
    expect(await res.json()).toEqual({ uuid: "abc-123" });
  });

  it("passes validated body to handler", async () => {
    const res = await call("/echo", {
      method: "POST",
      headers: { "content-type": "application/json", ...userHeaders(["test.write"]) },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("400 when the body validator throws", async () => {
    const res = await call("/strict", {
      method: "POST",
      headers: { "content-type": "application/json", ...userHeaders(["test.write"]) },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("public route skips auth entirely", async () => {
    const res = await call("/open");
    expect(res.status).toBe(200);
  });
});

describe("makeRpcRouter — api_key auth kind", () => {
  const port: ApiKeyPort = {
    async findByHash(): Promise<ApiKeyRecord | null> {
      return {
        uuid: "k1", name: "key", permissions: ["test.read"],
        is_system: false, is_active: true, expires_at: null,
      };
    },
  };
  const router = makeRpcRouter(
    [{ method: "GET", path: "/keyed", auth: "api_key", permissions: ["test.read"], handler: async () => ({ ok: true }) }],
    { apiKeyPort: port },
  );

  it("authenticates via ApiKey header", async () => {
    handler = router;
    const res = await call("/keyed", { headers: { authorization: "ApiKey pbk_test123" } });
    expect(res.status).toBe(200);
  });

  it("401 without the key", async () => {
    const res = await call("/keyed");
    expect(res.status).toBe(401);
  });
});

describe("makeRpcRouter — governed sse kind", () => {
  const router = makeRpcRouter([
    {
      method: "GET",
      path: "/stream",
      permissions: ["test.read"],
      streaming: "sse",
      handler: async ({ sse }) => {
        sse!.send({ event: "tick", data: { n: 1 } });
        sse!.close();
      },
    },
  ]);

  it("streams SSE with correct content-type", async () => {
    handler = router;
    const res = await call("/stream", { headers: userHeaders(["test.read"]) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: tick");
  });
});

describe("composeRouteHandlers", () => {
  it("tries handlers in order", async () => {
    const a = makeRpcRouter([{ method: "GET", path: "/a", auth: "public", handler: async () => "a" }]);
    const b = makeRpcRouter([{ method: "GET", path: "/b", auth: "public", handler: async () => "b" }]);
    handler = composeRouteHandlers(a, b);
    expect(await (await call("/a")).json()).toBe("a");
    expect(await (await call("/b")).json()).toBe("b");
    expect((await call("/c")).status).toBe(404);
  });
});
