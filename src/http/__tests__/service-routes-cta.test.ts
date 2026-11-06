/**
 * entity_op → served-meta CTA synthesis — the regression net for the
 * doctrine "RpcRoute.entity_op is the single source of truth for custom
 * entity actions". Asserts the FULL pipeline at the HTTP boundary:
 * entity_op.cta on the route → makeServiceRoutes synthesis → served
 * meta.table.row/bulk_custom_actions + meta.actions — with authored
 * meta.table entries surviving only as explicit overrides.
 */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../../auth/auth-config-cache.js", () => ({
  getAuthConfig: () => ({}),
}));

vi.mock("../../auth/verify-http.js", () => ({
  verifyHttpRequest: async () => ({
    id: "u1",
    idp_code: "idp",
    email: "a@b.c",
    name: "Admin",
    roles: ["admin"],
    permissions: new Set(["p"]),
    isAdmin: true,
    isSystem: false,
    idp_org: null,
    idp_username: null,
    ui_locale: null,
  }),
}));

import { makeServiceRoutes } from "../service-routes.js";
import type { RpcRoute } from "../rpc-router.js";
import type { EntityServiceLike } from "../entity-router.js";

function stubRes(chunks?: string[], status?: { code: number }): ServerResponse {
  return {
    writeHead: (code: number) => { if (status) status.code = code; return stubRes(chunks, status); },
    setHeader: () => {},
    end: (b?: string) => { if (b) chunks?.push(b); },
  } as unknown as ServerResponse;
}

function stubService(): EntityServiceLike {
  const fail = () => Promise.reject(new Error("not implemented"));
  return {
    list: fail, get: fail, create: fail, update: fail, delete: fail,
    restore: fail, purge: fail, duplicate: fail, bulkDelete: fail,
    bulkRestore: fail, audit: fail,
  } as EntityServiceLike;
}

async function servedMeta(
  h: ReturnType<typeof makeServiceRoutes>,
  entity: string,
): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const status = { code: 0 };
  const handled = await h(
    { method: "GET", headers: {} } as IncomingMessage,
    stubRes(chunks, status),
    new URL(`http://x/api/v1/entities/${entity}/meta`),
  );
  expect(handled).toBe(true);
  expect(status.code === 0 || status.code === 200).toBe(true);
  return JSON.parse(chunks[0]!);
}

const entityDecl = () => ({
  entityName: "job_schedule",
  service: stubService(),
  meta: {
    entity: "job_schedule",
    entities_ns: "job.jobs",
    uid: "subject",
    table: {},
  },
  permissions: { meta: ["p"], list: ["p"] },
});

const opRoutes: RpcRoute[] = [
  {
    method: "POST",
    path: "/api/v1/actions/stop-job",
    entity_op: {
      entity: "job_schedule",
      op: "stop",
      cta: {
        icon: "square",
        row_key: "schedule_subject",
        visible_on: { field: "status", values: ["armed"] },
      },
    },
    permissions: ["p"],
    handler: async () => ({}),
  },
  {
    method: "POST",
    path: "/api/v1/actions/disarm-all",
    entity_op: { entity: "job_schedule", op: "disarm_all" },
    permissions: ["_authenticated_admin"],
    handler: async () => ({}),
  },
  {
    method: "POST",
    path: "/api/v1/actions/ping-schedule",
    entity_op: { entity: "job_schedule", op: "ping" },
    permissions: ["p"],
    handler: async () => ({}),
  },
];

describe("entity_op → served meta CTA synthesis", () => {
  it("synthesizes row CTAs from entity_op.cta — meta.table is NOT required", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [entityDecl()],
      rpc: [opRoutes],
    });
    const meta = await servedMeta(h, "job_schedule");
    const table = meta.table as {
      row_custom_actions: Record<string, unknown>[];
      bulk_custom_actions: Record<string, unknown>[];
    };
    const stop = table.row_custom_actions.find((c) => c.action_name === "stop");
    expect(stop).toMatchObject({
      translation_key: "job.jobs.actions.stop",
      icon: "square",
      row_key: "schedule_subject",
      required_permission: ["p"],
      visible_on: { field: "status", values: ["armed"] },
    });
  });

  it("infers bulk placement for *_all ops + carries sentinel permissions as FE names", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [entityDecl()],
      rpc: [opRoutes],
    });
    const meta = await servedMeta(h, "job_schedule");
    const table = meta.table as { bulk_custom_actions: Record<string, unknown>[] };
    const disarm = table.bulk_custom_actions.find((c) => c.action_name === "disarm_all");
    expect(disarm).toMatchObject({
      translation_key: "job.jobs.actions.disarm_all",
      required_permission: ["AUTHENTICATED_ADMIN"],
      requires_selection: false,
    });
    // icon absent → key present but undefined — the FE must not render a placeholder
    expect(disarm!.icon).toBeUndefined();
  });

  it("defaults: row placement, row_key = meta.uid, translation_key = <ns>.actions.<op>", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [entityDecl()],
      rpc: [opRoutes],
    });
    const meta = await servedMeta(h, "job_schedule");
    const table = meta.table as { row_custom_actions: Record<string, unknown>[] };
    const ping = table.row_custom_actions.find((c) => c.action_name === "ping");
    expect(ping).toMatchObject({
      translation_key: "job.jobs.actions.ping",
      row_key: "subject", // meta.uid — not the default "uuid"
      required_permission: ["p"],
    });
  });

  it("meta.actions exposes the ops enabled with endpoint + permissions", async () => {
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [entityDecl()],
      rpc: [opRoutes],
    });
    const meta = await servedMeta(h, "job_schedule");
    const actions = meta.actions as { op: string; enabled: boolean; endpoint?: { path: string } }[];
    expect(actions.find((a) => a.op === "stop")).toMatchObject({
      enabled: true,
      endpoint: { path: "/api/v1/actions/stop-job" },
    });
    expect(actions.find((a) => a.op === "disarm_all")).toMatchObject({ enabled: true });
  });

  it("authored meta.table CTAs still merge as explicit overrides", async () => {
    const decl = entityDecl();
    decl.meta.table = {
      row_custom_actions: [
        { action_name: "stop", translation_key: "custom.stop", icon: "octagon" },
      ],
    };
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [decl],
      rpc: [opRoutes],
    });
    const meta = await servedMeta(h, "job_schedule");
    const table = meta.table as { row_custom_actions: Record<string, unknown>[] };
    const stop = table.row_custom_actions.find((c) => c.action_name === "stop");
    expect(stop).toMatchObject({ translation_key: "custom.stop", icon: "octagon" });
  });

  it("actions_overrides confirm_key/busy_key reach meta.actions — dialog copy is meta-driven", async () => {
    const decl = entityDecl();
    decl.permissions = {
      ...decl.permissions,
      delete: ["p"],
      bulkDelete: ["p"],
      restore: ["p"],
      bulkRestore: ["p"],
    };
    decl.meta.actions_overrides = {
      "delete.bulk": {
        label_key: "job.entities.job_trigger.actions.disable",
        icon: "exec-stop",
        color: "destructive",
        confirm_key: "job.entities.job_trigger.actions.disable_entities_confirm",
        busy_key: "job.entities.job_trigger.actions.disabling",
      },
      "restore.single": {
        label_key: "job.entities.job_trigger.actions.enable",
        icon: "exec-start",
        color: "success",
        confirm_key: "job.entities.job_trigger.actions.enable_confirm",
        busy_key: "job.entities.job_trigger.actions.enabling",
      },
    };
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [decl],
      rpc: [],
    });
    const meta = await servedMeta(h, "job_schedule");
    const actions = meta.actions as { op: string; confirm_key?: string; busy_key?: string }[];
    expect(actions.find((a) => a.op === "delete.bulk")).toMatchObject({
      confirm_key: "job.entities.job_trigger.actions.disable_entities_confirm",
      busy_key: "job.entities.job_trigger.actions.disabling",
    });
    expect(actions.find((a) => a.op === "restore.single")).toMatchObject({
      confirm_key: "job.entities.job_trigger.actions.enable_confirm",
      busy_key: "job.entities.job_trigger.actions.enabling",
    });
  });

  it("entity_op.cta confirm_key/busy_key merge onto a crud_action standard op", async () => {
    const decl = entityDecl();
    decl.permissions = { ...decl.permissions, delete: ["p"] };
    const rpc: RpcRoute[] = [
      {
        method: "POST",
        path: "/api/v1/actions/disable-schedule",
        entity_op: {
          entity: "job_schedule",
          op: "disable_row",
          crud_action: "delete.single",
          cta: {
            icon: "exec-stop",
            color: "destructive",
            confirm_key: "job.entities.job_schedule.actions.disable_confirm",
            busy_key: "job.entities.job_schedule.actions.disabling",
          },
        },
        permissions: ["p"],
        handler: async () => ({}),
      },
    ];
    const h = makeServiceRoutes({
      info: { title: "T", version: "0.0.0" },
      entities: [decl],
      rpc: [rpc],
    });
    const meta = await servedMeta(h, "job_schedule");
    const actions = meta.actions as { op: string; confirm_key?: string; busy_key?: string; endpoint?: { path: string } }[];
    expect(actions.find((a) => a.op === "delete.single")).toMatchObject({
      confirm_key: "job.entities.job_schedule.actions.disable_confirm",
      busy_key: "job.entities.job_schedule.actions.disabling",
      endpoint: { path: "/api/v1/actions/disable-schedule" },
    });
  });

  it("a resolved-pair divergence (crud_action icon + override color) fails at CONSTRUCTION", () => {
    const decl = entityDecl();
    decl.permissions = { ...decl.permissions, delete: ["p"] };
    decl.meta.actions_overrides = {
      // icon comes from the crud_action CTA, color from the override —
      // neither raw pair is invalid alone; the MERGED pair is.
      "delete.single": { color: "success" },
    };
    const rpc: RpcRoute[] = [
      {
        method: "POST",
        path: "/api/v1/actions/disable-schedule",
        entity_op: {
          entity: "job_schedule",
          op: "disable_row",
          crud_action: "delete.single",
          cta: { icon: "exec-stop" },
        },
        permissions: ["p"],
        handler: async () => ({}),
      },
    ];
    expect(() =>
      makeServiceRoutes({
        info: { title: "T", version: "0.0.0" },
        entities: [decl],
        rpc: [rpc],
      }),
    ).toThrow(/exec-stop.*destructive|destructive.*exec-stop/i);
  });
});
