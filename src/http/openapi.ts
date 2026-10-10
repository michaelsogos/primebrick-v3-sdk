/**
 * OpenAPI auto-generation — derives a real OpenAPI 3.1 spec from the SAME
 * route metadata that drives the runtime. No hand-written spec files, no
 * codegen step: the spec can never drift from the routes it describes.
 *
 * Composition:
 *   buildOpenApiSpec({
 *     info: { title, version, description },
 *     paths: {
 *       ...entityCrudSpec("provider", { ops: [...] }),
 *       ...entityCrudSpec("config_entry", { ops: [...] }),
 *       ...rpcSpec(myRpcRoutes),
 *     },
 *   })
 *
 * Serve it with `makeOpenApiHandler(spec)` — a RouteHandler answering
 * `GET /api/v1/openapi.json`. The endpoint is inside the client-identity
 * gate by default (it is not listed in identityExemptPaths): internal
 * callers authenticate with their client shield key, which is exactly how
 * the BE discovery fetcher reaches it.
 *
 * `entityCrudSpec` emits the canonical `/api/v1/entities/:entity/...` block —
 * that path table is a fixed convention, so the spec is derived mechanically
 * from the declared operation set instead of copied by hand.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extJsonStringify } from "../json/ext-json.js";
import type { RpcRoute } from "./rpc-router.js";

export type JsonSchema = Record<string, unknown>;

/** OpenAPI metadata declared on a single RpcRoute. */
export interface RpcRouteOpenApi {
  /** Short human/LLM summary — REQUIRED when `openapi` is present. */
  summary: string;
  description?: string;
  tags?: string[];
  /** JSON schema of the request body (POST/PUT/PATCH). */
  requestSchema?: JsonSchema;
  /** JSON schema of the 200 response body. */
  responseSchema?: JsonSchema;
  /** Path params override (default: `:name` segments → required string). */
  paramSchema?: Record<string, JsonSchema>;
}

// ─── operationId derivation ─────────────────────────────────────────────────

const PATH_VERB: Record<string, string> = { get: "get", post: "create", put: "update", patch: "patch", delete: "delete" };

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * operationId from method + path, snake_case:
 *   GET  /api/v1/entities/provider/list   → get_provider_list
 *   POST /api/v1/entities/provider        → create_provider
 *   GET  /api/v1/ai/conversations/:uuid   → get_ai_conversations_uuid
 */
export function operationIdFor(method: string, path: string): string {
  const verb = PATH_VERB[method.toLowerCase()] ?? method.toLowerCase();
  const segs = path
    .split("/")
    .filter(Boolean)
    .filter((s) => s !== "api" && s !== "v1" && s !== "entities")
    .map((s) => s.replace(/^:/, "").replace(/-/g, "_"));
  return camelToSnake(`${verb}_${segs.join("_")}`);
}

// ─── RPC routes → OpenAPI paths ─────────────────────────────────────────────

const AUTH_SECURITY: Record<string, Record<string, unknown[]>[]> = {
  user: [{ bearerAuth: [] }],
  api_key: [{ apiKey: [] }],
  public: [],
};

/** The subset of RpcRoute fields the spec generator reads — lets services
 *  document routes that aren't (yet) served through makeRpcRouter without
 *  fabricating handler bodies. */
export type OpenApiRouteDoc = Pick<RpcRoute, "method" | "path"> &
  Partial<Pick<RpcRoute, "auth" | "permissions" | "body" | "streaming" | "openapi">>;

/** Convert declared routes into an OpenAPI `paths` fragment. Routes
 *  without an `openapi` field are documented with path+method+security only —
 *  enough for discovery; `summary` upgrades them to full documentation. */
export function rpcSpec(routes: OpenApiRouteDoc[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const oapi = route.openapi;
    const openApiPath = route.path.replace(/:([^/]+)/g, "{$1}");
    const auth = route.auth ?? "user";

    const parameters = [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path" as const,
      required: true,
      schema: oapi?.paramSchema?.[m[1]!] ?? { type: "string" },
    }));

    const responses: Record<string, unknown> = {
      "200": {
        description: "Success",
        ...(oapi?.responseSchema
          ? { content: { "application/json": { schema: oapi.responseSchema } } }
          : {}),
      },
    };
    if (auth !== "public") {
      responses["401"] = { description: "Unauthorized" };
      responses["403"] = { description: "Forbidden — insufficient permissions" };
    }
    if (route.body) responses["400"] = { description: "Validation error" };

    const op: Record<string, unknown> = {
      operationId: operationIdFor(route.method, route.path),
      summary: oapi?.summary,
      description: oapi?.description,
      tags: oapi?.tags,
      security: AUTH_SECURITY[auth],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body && oapi?.requestSchema
        ? { requestBody: { required: true, content: { "application/json": { schema: oapi.requestSchema } } } }
        : route.body
          ? { requestBody: { required: true, content: { "application/json": {} } } }
          : {}),
      ...(route.streaming === "sse"
        ? { responses: { "200": { description: "Server-Sent Events stream", content: { "text/event-stream": {} } } } }
        : { responses }),
    };
    for (const k of Object.keys(op)) if (op[k] === undefined) delete op[k];

    paths[openApiPath] = { ...(paths[openApiPath] ?? {}), [route.method.toLowerCase()]: op };
  }
  return paths;
}

// ─── Canonical entity CRUD → OpenAPI paths ──────────────────────────────────

export type EntityCrudOp =
  | "meta" | "list" | "get" | "create" | "update" | "delete" | "purge" | "restore" | "audit"
  | "export" | "duplicate" | "bulk_delete" | "bulk_restore";

const UUID_PARAM = {
  name: "uuid",
  in: "path" as const,
  required: true,
  schema: { type: "string", format: "uuid" },
};

const ENTITY_WRITE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["entity"],
  properties: { entity: { type: "object" } },
};

/**
 * Emit the canonical `/api/v1/entities/:entity/...` path block. `ops` is the
 * exact set the service implements — the spec lists only real routes.
 * All operations are tagged `[tag]` (defaults to the plural-ish `<entity>s`
 * convention used by existing specs) and secured with bearerAuth+apiKey.
 */
export function entityCrudSpec(
  entity: string,
  opts: { ops: EntityCrudOp[]; tag?: string; label?: string; listResponse?: JsonSchema },
): Record<string, unknown> {
  const tag = opts.tag ?? `${entity}s`;
  const label = opts.label ?? entity;
  const base = `/api/v1/entities/${entity}`;
  const sec = [{ bearerAuth: [] }, { apiKey: [] }];
  const paths: Record<string, Record<string, unknown>> = {};
  const ops = new Set(opts.ops);
  const put = (path: string, method: string, op: Record<string, unknown>) => {
    paths[path] = { ...(paths[path] ?? {}), [method]: { tags: [tag], security: sec, ...op } };
  };

  if (ops.has("meta")) put(`${base}/meta`, "get", {
    operationId: `get_${tag}_meta`, summary: `Get ${label} entity metadata`,
    description: `Field schema, supported operations and actions for the ${tag} entity.`,
    responses: { "200": { description: "Entity metadata" } },
  });
  if (ops.has("list")) put(`${base}/list`, "get", {
    operationId: `list_${tag}`, summary: `List ${tag}`,
    description: `Paginated list of ${tag}. Supports search, search_in, sort_key, sort_dir, page, page_size, filters, deleted_records.`,
    responses: { "200": { description: `${label} list`, ...(opts.listResponse ? { content: { "application/json": { schema: opts.listResponse } } } : {}) } },
  });
  if (ops.has("export")) put(`${base}/export`, "get", {
    operationId: `export_${tag}`, summary: `Export ${tag}`,
    responses: { "200": { description: "Export file stream" } },
  });
  if (ops.has("get")) put(`${base}/{uuid}`, "get", {
    operationId: `get_${entity}`, summary: `Get a ${label} by UUID`, parameters: [UUID_PARAM],
    responses: { "200": { description: `${label} details` }, "404": { description: "Not found" } },
  });
  if (ops.has("create")) put(base, "post", {
    operationId: `create_${entity}`, summary: `Create a ${label}`,
    requestBody: { required: true, content: { "application/json": { schema: ENTITY_WRITE_SCHEMA } } },
    responses: { "201": { description: `${label} created` } },
  });
  if (ops.has("update")) put(`${base}/{uuid}`, "put", {
    operationId: `update_${entity}`, summary: `Update a ${label} by UUID`, parameters: [UUID_PARAM],
    requestBody: { required: true, content: { "application/json": { schema: ENTITY_WRITE_SCHEMA } } },
    responses: { "200": { description: `${label} updated` }, "404": { description: "Not found" } },
  });
  if (ops.has("delete")) put(`${base}/{uuid}`, "delete", {
    operationId: `delete_${entity}`, summary: `Soft-delete a ${label}`, parameters: [UUID_PARAM],
    responses: { "204": { description: `${label} deleted` }, "404": { description: "Not found" } },
  });
  if (ops.has("purge")) put(`${base}/{uuid}/purge`, "delete", {
    operationId: `purge_${entity}`, summary: `Permanently delete a ${label}`, parameters: [UUID_PARAM],
    responses: { "204": { description: `${label} purged` }, "404": { description: "Not found" } },
  });
  if (ops.has("restore")) put(`${base}/{uuid}/restore`, "post", {
    operationId: `restore_${entity}`, summary: `Restore a soft-deleted ${label}`, parameters: [UUID_PARAM],
    responses: { "200": { description: `${label} restored` }, "404": { description: "Not found" } },
  });
  if (ops.has("audit")) put(`${base}/{uuid}/audit`, "get", {
    operationId: `get_${entity}_audit`, summary: `Audit history for a ${label}`, parameters: [UUID_PARAM],
    responses: { "200": { description: "Audit entries" } },
  });
  if (ops.has("duplicate")) put(`${base}/duplicate`, "post", {
    operationId: `duplicate_${entity}`, summary: `Duplicate ${tag}`,
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["uuids"], properties: { uuids: { type: "array", items: { type: "string", format: "uuid" } } } } } } },
    responses: { "200": { description: "Duplicated entities" } },
  });
  if (ops.has("bulk_delete")) put(`${base}/bulk-delete`, "post", {
    operationId: `bulk_delete_${tag}`, summary: `Bulk soft-delete ${tag}`,
    responses: { "200": { description: "Bulk delete result" } },
  });
  if (ops.has("bulk_restore")) put(`${base}/bulk-restore`, "post", {
    operationId: `bulk_restore_${tag}`, summary: `Bulk restore ${tag}`,
    responses: { "200": { description: "Bulk restore result" } },
  });
  return paths;
}

// ─── Spec assembly + handler ────────────────────────────────────────────────

export interface OpenApiSpecInput {
  info: { title: string; version: string; description?: string };
  /** Service base URL — emitted as `servers[0].url`. */
  serverUrl?: string;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, unknown>;
}

export function buildOpenApiSpec(input: OpenApiSpecInput): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: input.info,
    ...(input.serverUrl ? { servers: [{ url: input.serverUrl, description: "Local development server" }] } : {}),
    security: [{ bearerAuth: [] }, { apiKey: [] }],
    ...(input.tags ? { tags: input.tags } : {}),
    paths: input.paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "OAuth 2.1 Bearer token from the Primebrick backend." },
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "API key for service-to-service authentication." },
      },
    },
  };
}

/** RouteHandler serving `GET /api/v1/openapi.json` with the given spec. */
export function makeOpenApiHandler(spec: Record<string, unknown>) {
  const body = extJsonStringify(spec);
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname === "/api/v1/openapi.json" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return true;
    }
    return false;
  };
}
