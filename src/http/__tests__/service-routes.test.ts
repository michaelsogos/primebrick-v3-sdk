import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeServiceRoutes } from "../service-routes.js";
import { isFactoryRouteHandler, type RpcRoute } from "../rpc-router.js";
import type { EntityServiceLike } from "../entity-router.js";

function stubRes(chunks?: string[], status?: { code: number }): ServerResponse {
  return {
    writeHead: (code: number) => { if (status) status.code = code; return stubRes(chunks, status); },
    setHeader: () => {},
    end: (b?: string) => { if (b) chunks?.push(b); },
  } as unknown as ServerResponse;
}

async function hits(h: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>, method: string, path: string): Promise<boolean> {
  const status = { code: 0 };
  try {
    const r = await h({ method, headers: {} } as IncomingMessage, stubRes(undefined, status), new URL(`http://x${path}`));
    // A 405 means the PATH exists for another method but THIS method's
    // route was never registered — that is not a hit.
    return r && status.code !== 405;
  } catch (err) {
    // Route matched → auth gate ran → threw before loadAuthConfig exists
    // in tests. The throw itself proves registration.
    if (err instanceof Error && err.message.includes("loadAuthConfig")) return true;
    throw err;
  }
}

function stubService(): EntityServiceLike {
  const fail = () => Promise.reject(new Error("not implemented"));
  return {
    list: fail, get: fail, create: fail, update: fail, delete: fail,
    restore: fail, purge: fail, duplicate: fail, bulkDelete: fail,
    bulkRestore: fail, audit: fail,
  } as EntityServiceLike;
}

async function servedSpec(h: ReturnType<typeof makeServiceRoutes>): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const handled = await h(
    { method: "GET", headers: {} } as IncomingMessage,
    stubRes(chunks),
    new URL("http://x/api/v1/openapi.json"),
  );
  expect(handled).toBe(true);
  return JSON.parse(chunks[0]!);
}

describe("makeServiceRoutes", () => {
  it("returns a factory-branded handler (createMicroservice accepts it)", () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      rpc: [[{ method: "GET", path: "/api/v1/ping", auth: "public", handler: async () => ({}) }]],
    });
    expect(isFactoryRouteHandler(h)).toBe(true);
  });

  it("spec paths derive from entity permissions — never restated", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [{
        entityName: "job_rule",
        service: stubService(),
        meta: { entity: "job_rule" },
        permissions: { list: ["p"], get: ["p"], delete: ["p"] },
        duplicate: false,
      }],
    });
    const spec = await servedSpec(h);
    const paths = spec.paths as Record<string, unknown>;
    // enabled ops are in the spec
    expect(paths).toHaveProperty("/api/v1/entities/job_rule/list");
    expect(paths["/api/v1/entities/job_rule/{uuid}"]).toMatchObject({ get: expect.anything(), delete: expect.anything() });
    // disabled ops are NOT
    expect(paths["/api/v1/entities/job_rule/{uuid}/restore"]).toBeUndefined();
    expect(paths["/api/v1/entities/job_rule/duplicate"]).toBeUndefined();
    expect(paths["/api/v1/entities/job_rule"]).not.toMatchObject({ post: expect.anything() });
    // and the registered routes agree with the spec
    expect(await hits(h, "GET", "/api/v1/entities/job_rule/list")).toBe(true);
    expect(await hits(h, "POST", "/api/v1/entities/job_rule/duplicate")).toBe(false);
    expect(await hits(h, "POST", "/api/v1/entities/job_rule")).toBe(false);
  });

  it("duplicate defaults ON (implied permission); meta requires cfg.meta", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [
        // duplicate implicit, meta perm declared but NO meta object → no meta
        { entityName: "a", service: stubService(), permissions: { list: ["p"], meta: ["p"] } },
        // duplicate explicitly off
        { entityName: "b", service: stubService(), permissions: { list: ["p"] }, duplicate: false },
      ],
    });
    const spec = await servedSpec(h);
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/api/v1/entities/a/duplicate");
    expect(paths).not.toHaveProperty("/api/v1/entities/a/meta");
    expect(paths).not.toHaveProperty("/api/v1/entities/b/duplicate");
    expect(await hits(h, "POST", "/api/v1/entities/a/duplicate")).toBe(true);
    expect(await hits(h, "GET", "/api/v1/entities/a/meta")).toBe(false);
  });

  it("rpc entries accept {routes, deps}; openapi metadata feeds the spec", async () => {
    const routes: RpcRoute[] = [{
      method: "POST",
      path: "/webhook/:service_code/:intent*",
      auth: "api_key",
      openapi: { summary: "Inbound webhook", tags: ["webhook"] },
      permissions: ["p"],
      handler: async () => ({}),
    }];
    const h = makeServiceRoutes({
      info: { title: "Webhook", version: "1.0.0" },
      rpc: [{ routes, deps: { apiKeyPort: () => null } }],
    });
    const spec = await servedSpec(h);
    expect(spec.paths).toHaveProperty("/webhook/{service_code}/{intent*}");
    expect(await hits(h, "POST", "/webhook/x/y")).toBe(true);
  });

  it("spec cosmetics (tag/label/listResponse) shape the entity block only", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [{
        entityName: "provider",
        service: stubService(),
        permissions: { list: ["p"] },
        spec: {
          tag: "providers",
          label: "email provider",
          listResponse: { type: "object", properties: { providers: { type: "array" } } },
        },
      }],
    });
    const spec = await servedSpec(h);
    const list = (spec.paths as Record<string, Record<string, { tags?: string[]; summary?: string; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>)["/api/v1/entities/provider/list"]!.get!;
    expect(list.tags).toEqual(["providers"]);
    expect(list.summary).toBe("List providers");
    expect(list.responses?.["200"]?.content?.["application/json"]?.schema).toMatchObject({ type: "object" });
  });

  it("handler serves both openapi.json and domain routes through one mount", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      rpc: [[{ method: "GET", path: "/api/v1/ping", auth: "public", handler: async () => ({ pong: true }) }]],
    });
    const chunks: string[] = [];
    const handled = await h(
      { method: "GET", headers: {} } as IncomingMessage,
      stubRes(chunks),
      new URL("http://x/api/v1/ping"),
    );
    expect(handled).toBe(true);
    expect(JSON.parse(chunks[0]!)).toEqual({ pong: true });
  });
});
