import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EntityMeta, MetaColumn } from "@primebrick/core";
import { entityFieldValidator } from "../entity-field-validator.js";
import { makeEntityRouter } from "../entity-router.js";
import { initAuthConfig, loadAuthConfig } from "../../auth/auth-config-cache.js";
import { serializeAuthUserToHeaders } from "../../auth/auth-user-serializer.js";
import { AuthMode, type AuthConfig, type AuthUser } from "../../auth/types.js";

const CFG: AuthConfig = {
  mode: AuthMode.GATEWAY,
  roles_path: "roles",
  oidc: {},
  gateway: {
    secret: "test-secret",
    secret_header_name: "x-client-shield-secret",
    headers: {},
  },
  enable_email_verification_check: false,
  enable_webauthn: false,
  passkey_required: false,
  enable_mfa: false,
};

const col = (over: Partial<MetaColumn>): MetaColumn =>
  ({ key: "f", label_key: "k", type: "text", order: 0, ...over }) as MetaColumn;

const META = {
  entity: "widget",
  translation_key: "widget",
  display_field: "name",
  columns: [
    col({ key: "name", nullable: false, max_length: 10 }),
    col({ key: "contact", nullable: true, format: "email" }),
    col({ key: "quota", nullable: true, format: "number", min: 0, max: 100 }),
  ],
  table: { entity: "widget", columns: [] },
} as unknown as EntityMeta;

// ─── unit level ─────────────────────────────────────────────────────────────

describe("entityFieldValidator", () => {
  const create = entityFieldValidator(META);
  const update = entityFieldValidator(META, { partial: true });

  it("rejects non-envelope bodies and unknown envelope keys", () => {
    expect(() => create("x")).toThrow(/envelope/);
    expect(() => create({})).toThrow(/must be an object/);
    expect(() => create({ entity: {}, extra: 1 })).toThrow(/unrecognized key/);
    expect(() => create({ entity: null })).toThrow(/must be an object/);
    expect(() => create({ entity: [], })).toThrow(/must be an object/);
  });

  it("create requires nullable:false columns; update validates present keys only", () => {
    expect(() => create({ entity: { contact: "a@b.c" } })).toThrow(/name: required/);
    expect(create({ entity: { name: "ok" } }).entity.name).toBe("ok");
    expect(() => update({ entity: { contact: "bad" } })).toThrow(/contact: invalid email/);
    expect(update({ entity: {} }).entity).toEqual({});
  });

  it("enforces format/max_length/bounds — the same rules the form binds", () => {
    expect(() => create({ entity: { name: "way-too-long-name" } })).toThrow(/at most 10/);
    expect(() => create({ entity: { name: "ok", quota: 101 } })).toThrow(/quota/);
    expect(() => create({ entity: { name: "ok", quota: "5" } })).toThrow(/quota: expected number/);
    expect(create({ entity: { name: "ok", quota: 5n } }).entity.quota).toBe(5n);
    expect(create({ entity: { name: "ok" }, translations: [] }).entity.name).toBe("ok");
  });
});

// ─── router level — enforcement by default (no schemas passed) ──────────────

describe("makeEntityRouter meta-derived default", () => {
  let server: Server;
  let base: string;

  const service = {
    list: async () => [],
    get: async () => ({}),
    create: async (e: Record<string, unknown>) => ({ uuid: "u-1", ...e }),
    update: async (_u: string, e: Record<string, unknown>) => ({ ...e }),
    delete: async () => ({}),
    restore: async () => ({}),
    purge: async () => ({}),
    duplicate: async () => ({}),
    bulkDelete: async () => ({}),
    bulkRestore: async () => ({}),
    audit: async () => ({}),
    stream: (async function* () {}) as never,
  };

  const handler = makeEntityRouter({
    entityName: "widget",
    service,
    meta: META,
    permissions: {
      create: ["_authenticated_user"],
      update: ["_authenticated_user"],
    },
    duplicate: false,
  });
  const router = handler;

  const user: AuthUser = {
    id: "u-1",
    idp_code: "casdoor/alice",
    email: "a@b.c",
    name: "Alice",
    roles: [],
    permissions: new Set(),
    isAdmin: false,
    isSystem: false,
    idp_org: null,
    idp_username: null,
  };
  const headers = () => ({
    "content-type": "application/json",
    ...serializeAuthUserToHeaders(user, CFG),
  });

  beforeAll(async () => {
    initAuthConfig({ load: async () => CFG });
    await loadAuthConfig();
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      void router(req, res, url).then((handled) => {
        if (!handled) res.writeHead(404).end();
      }).catch((e) => res.writeHead(500).end(String(e)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  const post = (body: unknown) =>
    fetch(`${base}/api/v1/entities/widget`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

  it("rejects a field the meta forbids — same rule as the form", async () => {
    const res = await post({ entity: { name: "ok", contact: "not-an-email" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail ?? JSON.stringify(body)).toMatch(/contact/);
  });

  it("accepts a conforming entity", async () => {
    const res = await post({ entity: { name: "ok", contact: "a@b.c", quota: 5 } });
    expect(res.status).toBe(201);
  });

  it("update is partial — absent required keys pass, present invalid fails", async () => {
    const uuid = "3f4b6b84-2c1d-4c8a-9a5f-9d2c1f7e8a9b";
    const bad = await fetch(`${base}/api/v1/entities/widget/${uuid}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ entity: { contact: "bad" } }),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/api/v1/entities/widget/${uuid}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ entity: { contact: "a@b.c" } }),
    });
    expect(ok.status).toBe(200);
  });
});
