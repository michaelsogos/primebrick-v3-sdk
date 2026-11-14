import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EntityMeta, MetaColumn, RelationFacet } from "@primebrick/core";
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

const RELATION: RelationFacet = {
  parent_field: "parent_customer_uuid",
  child_field: "child_customer_uuid",
  type_field: "type_uuid",
};

/** A relation entity meta — no display_field (forbidden by the DAL
 *  construction gate), the identity is the composite edge. */
const REL_META = {
  entity: "rel_link",
  translation_key: "rel_link",
  uid: "uuid",
  columns: [
    col({ key: "parent_customer_uuid", type: "ref", order: 10, immutable: true }),
    col({ key: "child_customer_uuid", type: "ref", order: 20, immutable: true }),
    col({ key: "type_uuid", type: "ref", order: 30 }),
  ],
} as unknown as EntityMeta;

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

describe("makeEntityRouter — relation facet in served meta", () => {
  let server: Server;
  let base: string;

  const handler = makeEntityRouter({
    entityName: "rel_link",
    service: { ...service, relationFacet: RELATION },
    meta: REL_META,
    permissions: { meta: ["_authenticated_user"] },
    duplicate: false,
  });

  beforeAll(async () => {
    initAuthConfig({ load: async () => CFG });
    await loadAuthConfig();
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      void handler(req, res, url).then((handled) => {
        if (!handled) res.writeHead(404).end();
      }).catch((e) => res.writeHead(500).end(String(e)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  it("injects the relation facet and serves display_name:null", async () => {
    const res = await fetch(`${base}/api/v1/entities/rel_link/meta`, {
      headers: serializeAuthUserToHeaders(user, CFG),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.relation).toEqual(RELATION);
    expect(body.display_name).toBeNull();
    expect(body.display_field).toBeUndefined();
  });
});

describe("makeEntityRouter — non-relation entities stay untouched", () => {
  let server: Server;
  let base: string;

  const NORMAL_META = {
    entity: "widget",
    translation_key: "widget",
    display_field: "name",
    columns: [col({ key: "name", order: 10 })],
  } as unknown as EntityMeta;

  const handler = makeEntityRouter({
    entityName: "widget",
    service,
    meta: NORMAL_META,
    permissions: { meta: ["_authenticated_user"] },
    duplicate: false,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      void handler(req, res, url).then((handled) => {
        if (!handled) res.writeHead(404).end();
      }).catch((e) => res.writeHead(500).end(String(e)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  it("still resolves display_name from display_field, no relation key", async () => {
    const res = await fetch(`${base}/api/v1/entities/widget/meta`, {
      headers: serializeAuthUserToHeaders(user, CFG),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.display_name).toBe("${name}");
    expect(body.relation).toBeUndefined();
  });
});
