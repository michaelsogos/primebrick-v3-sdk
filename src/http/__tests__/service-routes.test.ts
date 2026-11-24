import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeServiceRoutes } from "../service-routes.js";
import { isFactoryRouteHandler, type RpcRoute } from "../rpc-router.js";
import type { EntityServiceLike } from "../entity-router.js";

import { extJsonParse } from '../../json/ext-json.js';
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

function stubService(caps: { clonable?: boolean; auditable?: boolean } = {}): EntityServiceLike {
  const fail = () => Promise.reject(new Error("not implemented"));
  return {
    list: fail, get: fail, create: fail, update: fail, delete: fail,
    restore: fail, purge: fail, duplicate: fail, bulkDelete: fail,
    bulkRestore: fail, audit: fail,
    ...caps,
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
  return extJsonParse<any>(chunks[0]!);
}

describe("makeServiceRoutes", () => {
  it("returns a factory-branded handler (createMicroservice accepts it)", () => {
    const h = makeServiceRoutes({
      schemas: ["test"],
      info: { title: "T", version: "0.0.0" },
      rpc: [[{ method: "GET", path: "/api/v1/ping", auth: "public", handler: async () => ({}) }]],
    });
    expect(isFactoryRouteHandler(h)).toBe(true);
  });

  it("spec paths derive from entity permissions — never restated", async () => {
    const h = makeServiceRoutes({
      schemas: ["test"],
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
    expect(paths["/api/v1/entities/job_rule"]).toBeUndefined();
    // and the registered routes agree with the spec
    expect(await hits(h, "GET", "/api/v1/entities/job_rule/list")).toBe(true);
    expect(await hits(h, "POST", "/api/v1/entities/job_rule/duplicate")).toBe(false);
    expect(await hits(h, "POST", "/api/v1/entities/job_rule")).toBe(false);
  });

  it("bulk twins default-on with the single counterpart; explicit false opts out", async () => {
    const h = makeServiceRoutes({
      schemas: ["test"],
      info: { title: "T", version: "0.0.0" },
      entities: [
        // `delete` declared → bulkDelete defaults-on (inherited perms)
        { entityName: "a", service: stubService(), permissions: { list: ["p"], delete: ["a.del"] } },
        // explicit `false` → the ONLY way to keep the bulk route off
        { entityName: "b", service: stubService(), permissions: { list: ["p"], delete: ["b.del"], bulkDelete: false } },
        // explicit bulk perms still win over the inherited parent perms
        { entityName: "c", service: stubService(), permissions: { list: ["p"], delete: ["c.del"], bulkDelete: ["c.del.bulk"] } },
      ],
    });
    const spec = await servedSpec(h);
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/api/v1/entities/a/bulk-delete");
    expect(paths).not.toHaveProperty("/api/v1/entities/b/bulk-delete");
    expect(paths).toHaveProperty("/api/v1/entities/c/bulk-delete");
    expect(await hits(h, "POST", "/api/v1/entities/a/bulk-delete")).toBe(true);
    expect(await hits(h, "POST", "/api/v1/entities/b/bulk-delete")).toBe(false);
    expect(await hits(h, "POST", "/api/v1/entities/c/bulk-delete")).toBe(true);
  });

  it("duplicate registers only on clonable services; meta requires cfg.meta", async () => {
    const h = makeServiceRoutes({
      schemas: ["test"],
      info: { title: "T", version: "0.0.0" },
      entities: [
        // clonable + duplicate implicit, meta perm declared but NO meta object → no meta
        { entityName: "a", service: stubService({ clonable: true }), permissions: { list: ["p"], meta: ["p"] } },
        // clonable but duplicate explicitly off
        { entityName: "b", service: stubService({ clonable: true }), permissions: { list: ["p"] }, duplicate: false },
        // NOT clonable → implied duplicate never registers
        { entityName: "c", service: stubService(), permissions: { list: ["p"] } },
      ],
    });
    const spec = await servedSpec(h);
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/api/v1/entities/a/duplicate");
    expect(paths).not.toHaveProperty("/api/v1/entities/a/meta");
    expect(paths).not.toHaveProperty("/api/v1/entities/b/duplicate");
    expect(paths).not.toHaveProperty("/api/v1/entities/c/duplicate");
    expect(await hits(h, "POST", "/api/v1/entities/a/duplicate")).toBe(true);
    expect(await hits(h, "POST", "/api/v1/entities/c/duplicate")).toBe(false);
    expect(await hits(h, "GET", "/api/v1/entities/a/meta")).toBe(false);
  });

  it("duplicate config on a non-clonable service fails at construction", () => {
    expect(() =>
      makeServiceRoutes({
        schemas: ["test"],
        info: { title: "T", version: "0.0.0" },
        entities: [{
          entityName: "e",
          service: stubService(),
          permissions: { list: ["p"], duplicate: ["e.duplicate.bulk"] },
        }],
      }),
    ).toThrow(/not clonable/);
    expect(() =>
      makeServiceRoutes({
        schemas: ["test"],
        info: { title: "T", version: "0.0.0" },
        entities: [{
          entityName: "e",
          service: stubService(),
          permissions: { list: ["p"] },
          schemas: { duplicateBody: {} as never },
        }],
      }),
    ).toThrow(/not clonable/);
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
      schemas: ["test"],
      info: { title: "Webhook", version: "1.0.0" },
      rpc: [{ routes, deps: { apiKeyPort: () => null } }],
    });
    const spec = await servedSpec(h);
    expect(spec.paths).toHaveProperty("/webhook/{service_code}/{intent*}");
    expect(await hits(h, "POST", "/webhook/x/y")).toBe(true);
  });

  it("spec cosmetics (tag/label/listResponse) shape the entity block only", async () => {
    const h = makeServiceRoutes({
      schemas: ["test"],
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

  describe("entity_op — custom action ops", () => {
    const entityDecl = () => ({
      entityName: "job_schedule",
      service: stubService(),
      meta: {
        entity: "job_schedule",
        table: {
          row_custom_actions: [
            { action_name: "stop", translation_key: "x.stop", icon: "square", row_key: "schedule_subject" },
          ],
          bulk_custom_actions: [
            { action_name: "disarm_all", translation_key: "x.disarm_all", icon: "power", requires_selection: false, confirm_key: "x.confirm" },
          ],
        },
      },
      permissions: { meta: ["p"] },
    });
    const opRoutes: RpcRoute[] = [
      {
        method: "POST",
        path: "/api/v1/actions/stop-job",
        entity_op: { entity: "job_schedule", op: "stop" },
        permissions: ["p"],
        handler: async () => ({}),
      },
      {
        method: "POST",
        path: "/api/v1/actions/disarm-all",
        entity_op: { entity: "job_schedule", op: "disarm_all" },
        permissions: ["p"],
        handler: async () => ({}),
      },
    ];

    it("constructs when every meta action is backed by an entity_op route", async () => {
      const h = makeServiceRoutes({
        schemas: ["test"],
        info: { title: "T", version: "0.0.0" },
        entities: [entityDecl()],
        rpc: [opRoutes],
      });
      expect(await hits(h, "GET", "/api/v1/entities/job_schedule/meta")).toBe(true);
      expect(await hits(h, "POST", "/api/v1/actions/stop-job")).toBe(true);
    });

    it("fails fast when a meta row/bulk action has no backing entity_op", () => {
      expect(() =>
        makeServiceRoutes({
          schemas: ["test"],
          info: { title: "T", version: "0.0.0" },
          entities: [entityDecl()],
          rpc: [opRoutes.slice(0, 1)], // only "stop" — disarm_all unbacked
        }),
      ).toThrow(/disarm_all.*no backing route/);
    });

    it("fails fast when entity_op names an entity with no decl", () => {
      expect(() =>
        makeServiceRoutes({
          schemas: ["test"],
          info: { title: "T", version: "0.0.0" },
          entities: [],
          rpc: [opRoutes],
        }),
      ).toThrow(/no entity decl/);
    });

    it("fails fast on duplicate entity_op for the same entity+op", () => {
      const dup: RpcRoute[] = [
        ...opRoutes,
        {
          method: "POST",
          path: "/api/v1/actions/stop-job-again",
          entity_op: { entity: "job_schedule", op: "stop" },
          permissions: ["p"],
          handler: async () => ({}),
        },
      ];
      expect(() =>
        makeServiceRoutes({
          schemas: ["test"],
          info: { title: "T", version: "0.0.0" },
          entities: [entityDecl()],
          rpc: [dup],
        }),
      ).toThrow(/duplicate custom op "stop"/);
    });
  });

  it("handler serves both openapi.json and domain routes through one mount", async () => {
    const h = makeServiceRoutes({
      schemas: ["test"],
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
    expect(extJsonParse<any>(chunks[0]!)).toEqual({ pong: true });
  });
});

describe("builtin rpc routes — registry merge", () => {
  const REG = Symbol.for("primebrick.builtin-entity-decl-factories") as symbol;
  type RegistryMap = Map<string, { id: string; make: (ctx: unknown) => Record<string, unknown>[]; rpc?: (ctx: unknown) => Record<string, unknown>[] }>;
  const reg = () => ((globalThis as Record<symbol, RegistryMap | undefined>)[REG] ??= new Map());

  it("builtin-declared rpc routes mount, bind entity_op on the builtin entity, and feed OpenAPI", async () => {
    reg().set("test.builtin", {
      id: "test.builtin",
      make: () => [{
        entityName: "fake_builtin",
        service: stubService(),
        meta: { entity: "fake_builtin" },
        permissions: { list: ["fb.read.all"], get: ["fb.read.single"] },
      }],
      rpc: () => [{
        method: "POST",
        path: "/api/v1/actions/fake-builtin-set",
        permissions: ["fb.set.single"],
        auth: "user",
        mfa: { action: "fb.set", target_resource: "fake_builtin" },
        entity_op: { entity: "fake_builtin", op: "fake_set", cta: { confirm_key: "fb.confirm" } },
        openapi: { summary: "Fake builtin op" },
        body: (raw: unknown) => raw,
        handler: async () => ({ ok: true }),
      }],
    });
    try {
      const h = makeServiceRoutes({ schemas: ["test"], info: { title: "T", version: "0.0.0" } });
      // mounted
      expect(await hits(h, "POST", "/api/v1/actions/fake-builtin-set")).toBe(true);
      // the builtin entity decl is in the served decl set (entity_op binding
      // → meta.actions is covered by the service-routes-cta suite)
      expect(h.entityDecls.some((d) => d.entityName === "fake_builtin")).toBe(true);
      // OpenAPI carries the builtin route
      const spec = await servedSpec(h);
      expect((spec.paths as Record<string, unknown>)["/api/v1/actions/fake-builtin-set"]).toBeDefined();
    } finally {
      reg().delete("test.builtin");
    }
  });
});
