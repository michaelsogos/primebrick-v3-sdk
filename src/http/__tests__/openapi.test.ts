import { describe, it, expect } from "vitest";
import { buildOpenApiSpec, entityCrudSpec, rpcSpec, makeOpenApiHandler, operationIdFor } from "../openapi.js";
import type { RpcRoute } from "../rpc-router.js";
import type { IncomingMessage, ServerResponse } from "node:http";

describe("operationIdFor", () => {
  it("derives snake_case ids from method+path", () => {
    expect(operationIdFor("GET", "/api/v1/entities/provider/list")).toBe("get_provider_list");
    expect(operationIdFor("POST", "/api/v1/entities/provider")).toBe("create_provider");
    expect(operationIdFor("GET", "/api/v1/ai/conversations/:uuid")).toBe("get_ai_conversations_uuid");
    expect(operationIdFor("POST", "/api/v1/ai/chat")).toBe("create_ai_chat");
    expect(operationIdFor("POST", "/api/v1/actions/send-email")).toBe("create_actions_send_email");
  });
});

describe("rpcSpec", () => {
  const routes: RpcRoute[] = [
    {
      method: "POST",
      path: "/api/v1/ai/chat",
      auth: "user",
      permissions: ["ai.chat"],
      streaming: "sse",
      openapi: { summary: "Chat with AI", tags: ["ai"], requestSchema: { type: "object" } },
      handler: async () => ({}),
    },
    {
      method: "GET",
      path: "/api/v1/ai/conversations/:uuid",
      permissions: ["ai.conversations.read"],
      openapi: { summary: "Get conversation" },
      handler: async () => ({}),
    },
    { method: "GET", path: "/api/v1/system/ping", auth: "public", handler: async () => ({ pong: true }) },
  ];

  it("emits paths keyed by templated path with auth/security derived", () => {
    const paths = rpcSpec(routes) as Record<string, Record<string, Record<string, unknown>>>;
    const chat = paths["/api/v1/ai/chat"]!.post!;
    expect(chat.operationId).toBe("create_ai_chat");
    expect(chat.summary).toBe("Chat with AI");
    expect(chat.security).toEqual([{ bearerAuth: [] }]);
    expect((chat.responses as Record<string, unknown>)["200"]).toMatchObject({ description: "Server-Sent Events stream" });

    const conv = paths["/api/v1/ai/conversations/{uuid}"]!.get!;
    expect((conv.parameters as unknown[]).length).toBe(1);
    expect(conv.security).toEqual([{ bearerAuth: [] }]);

    const ping = paths["/api/v1/system/ping"]!.get!;
    expect(ping.security).toEqual([]);
  });

  it("documents body-less routes without requestBody", () => {
    const paths = rpcSpec(routes) as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/api/v1/ai/conversations/{uuid}"]!.get!.requestBody).toBeUndefined();
  });
});

describe("entityCrudSpec", () => {
  it("emits only declared ops with canonical paths", () => {
    const paths = entityCrudSpec("provider", {
      ops: ["meta", "list", "get", "create", "update", "delete"],
      tag: "providers",
    }) as Record<string, Record<string, unknown>>;

    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/entities/provider/meta",
        "/api/v1/entities/provider/list",
        "/api/v1/entities/provider/{uuid}",
        "/api/v1/entities/provider",
      ]),
    );
    expect(paths["/api/v1/entities/provider"]!.post!.operationId).toBe("create_provider");
    expect(paths["/api/v1/entities/provider/{uuid}"]!.get!.operationId).toBe("get_provider");
    expect(paths["/api/v1/entities/provider/{uuid}"]!.delete!.operationId).toBe("delete_provider");
    // undeclared ops are absent
    expect(paths["/api/v1/entities/provider/{uuid}/restore"]).toBeUndefined();
    expect(paths["/api/v1/entities/provider/export"]).toBeUndefined();
  });
});

describe("buildOpenApiSpec + makeOpenApiHandler", () => {
  it("assembles a valid 3.1 spec and serves it at /api/v1/openapi.json", async () => {
    const spec = buildOpenApiSpec({
      info: { title: "AI Catalog", version: "1.0.0" },
      serverUrl: "http://localhost:3004",
      tags: [{ name: "ai", description: "AI endpoints" }],
      paths: {
        ...entityCrudSpec("conversation", { ops: ["list", "get"] }),
        ...rpcSpec([{ method: "POST", path: "/api/v1/ai/chat", auth: "user", permissions: ["ai.chat"], handler: async () => ({}) }]),
      },
    });
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths).toHaveProperty("/api/v1/entities/conversation/list");
    expect(spec.paths).toHaveProperty("/api/v1/ai/chat");

    const handler = makeOpenApiHandler(spec);
    const chunks: string[] = [];
    const res = {
      writeHead: () => res,
      end: (b: string) => chunks.push(b),
    } as unknown as ServerResponse;
    const handled = await handler(
      { method: "GET" } as IncomingMessage,
      res,
      new URL("http://x/api/v1/openapi.json"),
    );
    expect(handled).toBe(true);
    expect(JSON.parse(chunks[0]!).openapi).toBe("3.1.0");

    const miss = await handler({ method: "GET" } as IncomingMessage, res, new URL("http://x/other"));
    expect(miss).toBe(false);
  });
});
