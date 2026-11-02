/**
 * entity-router — canonical CRUD router factory for
 * `/api/v1/entities/{name}` on microservices.
 *
 * The US-edition counterpart of the BE's Express `makeEntityRouter`: the
 * same route table, the same mandatory chain (auth → RBAC → validation →
 * ONE service call → RFC 7807), emitted as governed `RpcRoute`s so the
 * result carries the factory brand required by `createMicroservice`.
 *
 * Standard actions and their defaults (a route is registered iff
 * `permissions.<action>` is present — declaring the permission declares
 * the route, exactly like the BE):
 *
 *   meta         GET    /meta                     -> assembled meta + actions
 *   list         GET    /list      [query schema] -> service.list(query)
 *   create       POST   /          [body schema]  -> service.create(entity) → 201
 *   duplicate    POST   /duplicate [body schema]  -> service.duplicate(uuids)
 *   bulkDelete   POST   /bulk-delete              -> service.bulkDelete(items)
 *   bulkRestore  POST   /bulk-restore             -> service.bulkRestore(items)
 *   get          GET    /:uuid                    -> service.get(uuid)
 *   update       PUT    /:uuid     [body schema]  -> service.update(uuid, entity)
 *   delete       DELETE /:uuid                    -> service.delete(uuid, ?version)
 *   purge        DELETE /:uuid/purge              -> service.purge(uuid, ?version)
 *   restore      POST   /:uuid/restore            -> service.restore(uuid, ?version)
 *   audit        GET    /:uuid/audit [query]      -> service.audit(uuid, page, limit)
 *
 * Differences vs the BE version (all structural, no feature drift):
 * - schemas are plain validators `(raw) => T` — the SDK stays zod-free; the
 *   service injects `schema.parse` bound to its own zod (or any validator).
 * - the `{entity, translations}` write envelope becomes `{entity}`-only:
 *   piggyback translation writes are gateway-owned (translations live in
 *   the BE's system schema) — a US entity route MUST NOT accept them. The
 *   caller's create/update schema should `.strict()`-reject a
 *   `translations` key.
 * - `guards` replaces Express action middlewares: an async hook invoked
 *   inside the route's mandatory chain before the service call (e.g. the
 *   MFA step-up consume — B9).
 * - tx orchestration (`runEntityWrite`) is unnecessary: there is no
 *   translations piggyback, so writes are single-call.
 * - `meta.actions` is DERIVED from the registered ops — same canonical op
 *   vocabulary as the BE (`create.single`, `delete.bulk`, ...), with
 *   `enabled: false` for ops whose route was not registered.
 */

import { extJsonStringify } from "../json/ext-json.js";
import { STANDARD_OPS, type EntityMeta } from "@primebrick/core";
import {
  streamEntityExport,
  type EntityExportConfig,
  type EntityExportQuery,
} from "./entity-export.js";
import {
  makeRpcRouter,
  ValidationError,
  type RouteHandler,
  type RpcRoute,
  type RpcRouteContext,
} from "./rpc-router.js";

// ─── Structural service contract ─────────────────────────────────────────────
// The SDK cannot import @primebrick/dal-pg (dependency direction is
// dal → sdk, never the reverse) — the contract is declared structurally and
// satisfied by dal-pg's `makeEntityService` output.

export interface EntityServiceLike<TEntity = unknown> {
  list(query: Record<string, unknown>): Promise<unknown>;
  get(uuid: string): Promise<TEntity>;
  create(body: Record<string, unknown>): Promise<TEntity>;
  update(uuid: string, body: Record<string, unknown>): Promise<TEntity>;
  delete(uuid: string, version: number): Promise<TEntity>;
  restore(uuid: string, version: number): Promise<TEntity>;
  purge(uuid: string, version: number): Promise<TEntity>;
  duplicate(uuids: string[]): Promise<unknown>;
  bulkDelete(items: Array<{ uuid: string; version: number }>): Promise<unknown>;
  bulkRestore(items: Array<{ uuid: string; version: number }>): Promise<unknown>;
  audit(uuid: string, page: number, limit: number): Promise<unknown>;
  /** Row stream for `export` — the SAME query/filter contract as `list`. */
  stream(query: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
}

export type EntityAction =
  | "meta"
  | "list"
  | "export"
  | "create"
  | "duplicate"
  | "bulkDelete"
  | "bulkRestore"
  | "get"
  | "update"
  | "delete"
  | "purge"
  | "restore"
  | "audit";

const ACTION_TO_OP: Record<EntityAction, string> = {
  meta: "meta",
  list: "list",
  export: "export",
  get: "get",
  create: "create.single",
  update: "update.single",
  delete: "delete.single",
  purge: "purge.single",
  restore: "restore.single",
  audit: "read.audit",
  duplicate: "duplicate.bulk",
  bulkDelete: "delete.bulk",
  bulkRestore: "restore.bulk",
};

export interface EntityActionMeta {
  op: string;
  permissions: string[];
  sentinel?: string;
  enabled: boolean;
}

const SENTINEL_RE = /^_(public|authenticated_user|authenticated_admin)$/;

export interface EntityRouterConfig<TEntity = unknown> {
  /** Entity URL segment, e.g. "ai_model" → /api/v1/entities/ai_model/* */
  entityName: string;
  service: EntityServiceLike<TEntity>;
  /** Permission per action — presence registers the route. */
  permissions: Partial<Record<EntityAction, readonly string[]>>;
  /** Static entity meta — served by GET /meta with derived
   *  `display_name` + `actions` + `collaboration`. When omitted, the meta
   *  route is not registered even if `permissions.meta` is set. */
  meta?: EntityMeta;
  /** The entity is auditable (@AuditTrail) — drives `collaboration.enabled`
   *  in the meta response (the BE derives it from entity persistence meta;
   *  the SDK cannot inspect decorators, so the caller declares it). */
  auditable?: boolean;
  /**
   * Validators — plain `(raw) => T` functions. `listQuery`/`auditQuery`
   * receive the parsed bracket-notation query object; `createBody`/
   * `updateBody`/`duplicateBody` receive the parsed JSON body and MUST
   * validate the `{entity}` envelope (strict — reject `translations`).
   * Throw `ValidationError` (or anything — it is wrapped) on failure.
   */
  schemas?: {
    listQuery?: (query: Record<string, unknown>) => Record<string, unknown>;
    createBody?: (body: unknown) => { entity: Record<string, unknown> };
    updateBody?: (body: unknown) => { entity: Record<string, unknown> };
    auditQuery?: (query: Record<string, unknown>) => { page: number; limit: number };
    duplicateBody?: (body: unknown) => { uuids: string[] };
    /** Export query — extends the `listQuery` contract with
     *  `file_type`/`locale`/`timezone`. */
    exportQuery?: (query: Record<string, unknown>) => EntityExportQuery;
  };
  /** `duplicate` is ON by default (BE E.8): registers with the conventional
   *  `<entity>.duplicate.bulk` permission when not declared. `false`
   *  disables the route entirely. */
  duplicate?: false;
  /** Export behaviour — column allowlist, template overrides, label
   *  resolution. Requires `permissions.export` (the route) and `meta`
   *  (the column driver). See `entity-export.ts`. */
  export?: EntityExportConfig;
  /** Async per-action guards invoked before the service call — the US
   *  replacement for Express action middlewares (MFA step-up, B9). */
  guards?: Partial<Record<EntityAction, (ctx: RpcRouteContext) => void | Promise<void>>>;
}

// ─── Bracket-notation query parser ──────────────────────────────────────────
// `filters[0][field]=x&filters[0][op]==` → { filters: [{field:"x",op:"="}] }
// `search_in[]=a&search_in[]=b`        → { search_in: ["a","b"] }
// `a=1&a=2`                            → { a: ["1","2"] }
// Everything else stays a flat scalar — the same surface Express `qs`
// produces for the canonical entity-list query params.

const BRACKET_RE = /^([^\[\]]+)((?:\[[^\[\]]*\])*)$/;
const INDEX_RE = /^\d+$/;

export function parseBracketQuery(
  params: URLSearchParams,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const m = key.match(BRACKET_RE);
    if (!m) continue;
    const base = m[1]!;
    const segments = [...(m[2] ?? "").matchAll(/\[([^\[\]]*)\]/g)].map(
      (s) => s[1]!,
    );
    if (segments.length === 0) {
      const prev = root[base];
      root[base] =
        prev === undefined
          ? value
          : [...(Array.isArray(prev) ? prev : [prev]), value];
      continue;
    }
    assignBracketPath(root, base, segments, value);
  }
  return root;
}

/**
 * Walk `root[base]` following `segments` — creating `{}`/`[]` containers
 * shaped by the NEXT segment (numeric or `""` → array, otherwise object)
 * — and assign `value` at the leaf. `""` leaf segment pushes onto an array.
 */
function assignBracketPath(
  root: Record<string, unknown>,
  base: string,
  segments: string[],
  value: string,
): void {
  const isIndex = (s: string) => INDEX_RE.test(s);
  const isPush = (s: string) => s === "";
  const wantArray = (s: string | undefined) => s !== undefined && (isIndex(s) || isPush(s));

  // Ensure root[base] container shape matches the first segment.
  if (root[base] === undefined) root[base] = wantArray(segments[0]) ? [] : {};

  let cur = root[base] as Record<string, unknown> | unknown[];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;

    if (Array.isArray(cur)) {
      const idx = isPush(seg) ? cur.length : Number(seg);
      if (last) {
        cur[idx] = value;
      } else {
        if (cur[idx] === undefined || typeof cur[idx] !== "object") {
          cur[idx] = wantArray(segments[i + 1]) ? [] : {};
        }
        cur = cur[idx] as Record<string, unknown> | unknown[];
      }
      continue;
    }

    // object node
    if (last) {
      if (isPush(seg) || isIndex(seg)) {
        const arr = (cur[seg] ??= []) as unknown[];
        if (isPush(seg)) {
          // `key[]` — seg is "" so cur[""] is wrong; push onto the key the
          // caller used. Handled by caller shape: treat as push on a named
          // array stored under the previous key — the parent path already
          // resolved it, so simply push.
          arr.push(value);
        } else {
          arr[Number(seg)] = value;
        }
      } else {
        cur[seg] = value;
      }
      return;
    }

    if (cur[seg] === undefined || typeof cur[seg] !== "object") {
      cur[seg] = wantArray(segments[i + 1]) ? [] : {};
    }
    cur = cur[seg] as Record<string, unknown> | unknown[];
  }
}

// ─── Query coercion ──────────────────────────────────────────────────────────

function requireVersion(query: URLSearchParams): number {
  const raw = query.get("version");
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(
      "Query param 'version' (int) is required for this write",
      "VERSION_REQUIRED",
    );
  }
  return n;
}

const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidParam(ctx: RpcRouteContext): string {
  const uuid = ctx.params["uuid"];
  if (!uuid || !UUID_PARAM_RE.test(uuid)) {
    throw new ValidationError("Request validation failed");
  }
  return uuid;
}

/** Schema validators are plain `(raw) => T` functions — consumers wire
 *  `zodSchema.parse` directly, whose ZodError must surface as HTTP 400,
 *  not an unhandled 500. Any non-ValidationError throw is wrapped. */
function runValidator<T>(fn: (input: never) => T, input: unknown): T {
  try {
    return fn(input as never);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(e instanceof Error ? e.message : String(e));
  }
}

function parseBulkItems(body: unknown): Array<{ uuid: string; version: number }> {
  const items = (body as { items?: unknown })?.items;
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > 100 ||
    !items.every(
      (i) =>
        i &&
        typeof i === "object" &&
        UUID_PARAM_RE.test((i as { uuid?: string }).uuid ?? "") &&
        Number.isInteger((i as { version?: number }).version),
    )
  ) {
    throw new ValidationError(
      "Body must be { items: [{ uuid, version }] } — 1..100 items",
    );
  }
  return items as Array<{ uuid: string; version: number }>;
}

function defaultDuplicateBody(body: unknown): { uuids: string[] } {
  const uuids = (body as { uuids?: unknown })?.uuids;
  if (
    !Array.isArray(uuids) ||
    uuids.length < 1 ||
    uuids.length > 100 ||
    !uuids.every((u) => typeof u === "string" && UUID_PARAM_RE.test(u))
  ) {
    throw new ValidationError("Body must be { uuids: string[] } — 1..100 uuids");
  }
  return { uuids };
}

// ─── Meta assembly ───────────────────────────────────────────────────────────

function deriveActions(
  cfg: EntityRouterConfig,
  registered: Set<EntityAction>,
): EntityActionMeta[] {
  const overrides = cfg.meta?.actions_overrides ?? {};
  const permsFor = (a: EntityAction): readonly string[] | undefined => {
    if (a === "duplicate" && !cfg.permissions.duplicate && cfg.duplicate !== false) {
      return [`${cfg.entityName}.duplicate.bulk`];
    }
    return cfg.permissions[a];
  };
  return STANDARD_OPS.map((op) => {
    const action = (Object.keys(ACTION_TO_OP) as EntityAction[]).find(
      (a) => ACTION_TO_OP[a] === op,
    );
    const hasRoute = action !== undefined && registered.has(action);
    const perms = action ? (permsFor(action) ?? []) : [];
    const sentinel = perms.find((p) => SENTINEL_RE.test(p));
    return {
      op,
      permissions: perms.filter((p) => !SENTINEL_RE.test(p)),
      ...(sentinel ? { sentinel } : {}),
      enabled: hasRoute && (overrides[op]?.enabled !== false),
    };
  });
}

function assembleMeta(
  cfg: EntityRouterConfig,
  registered: Set<EntityAction>,
): Record<string, unknown> {
  const meta = cfg.meta!;
  return {
    ...meta,
    display_name:
      (meta.display_name as string | undefined) ??
      (meta.display_field ? `\${${meta.display_field}}` : null),
    collaboration: {
      enabled: cfg.auditable === true,
      expose_editing_value: true,
    },
    actions: deriveActions(cfg, registered),
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function makeEntityRouter<TEntity = unknown>(
  config: EntityRouterConfig<TEntity>,
): RouteHandler {
  const base = `/api/v1/entities/${config.entityName}`;
  const service = config.service;
  const registered = new Set<EntityAction>();

  // `export` columns derive from `meta` — declaring the permission without
  // the meta is a config error, fail fast at construction.
  if (config.permissions.export && !config.meta) {
    throw new Error(
      `entity-router[${config.entityName}]: permissions.export requires "meta" — export columns derive from it`,
    );
  }

  const guard = (a: EntityAction) => config.guards?.[a];
  const runGuard = async (a: EntityAction, ctx: RpcRouteContext) => {
    await guard(a)?.(ctx);
  };

  const enabled = (a: EntityAction): readonly string[] | undefined => {
    if (a === "duplicate" && !config.permissions.duplicate && config.duplicate !== false) {
      return [`${config.entityName}.duplicate.bulk`];
    }
    return config.permissions[a];
  };

  const routes: RpcRoute[] = [];
  const push = (
    a: EntityAction,
    def: Omit<RpcRoute, "permissions" | "handler"> & {
      handler: RpcRoute["handler"];
    },
  ) => {
    const perms = enabled(a);
    if (!perms) return;
    registered.add(a);
    routes.push({ ...def, permissions: perms, auth: "user" });
  };

  if (config.meta) {
    push("meta", {
      method: "GET",
      path: `${base}/meta`,
      handler: async () => assembleMeta(config, registered),
    });
  }

  push("list", {
    method: "GET",
    path: `${base}/list`,
    handler: async (ctx) => {
      const parsed = parseBracketQuery(ctx.query);
      const q = config.schemas?.listQuery
        ? runValidator(config.schemas.listQuery, parsed)
        : parsed;
      return service.list(q);
    },
  });

  push("export", {
    method: "GET",
    path: `${base}/export`,
    handler: async (ctx) => {
      await runGuard("export", ctx);
      const parsed = parseBracketQuery(ctx.query);
      const q = config.schemas?.exportQuery
        ? runValidator(config.schemas.exportQuery, parsed)
        : (parsed as EntityExportQuery);
      if (q.file_type !== "csv" && q.file_type !== "xlsx" && q.file_type !== "html") {
        throw new ValidationError("Query param 'file_type' must be csv|xlsx|html");
      }
      await streamEntityExport(
        {
          entityName: config.entityName,
          meta: config.meta!,
          stream: (qq) => service.stream(qq),
          export: config.export,
        },
        q,
        ctx.res,
      );
    },
  });

  push("create", {
    method: "POST",
    path: base,
    body: (raw) => {
      const validated = config.schemas?.createBody
        ? config.schemas.createBody(raw)
        : (raw as { entity: Record<string, unknown> });
      if (!validated || typeof validated !== "object" || !("entity" in validated)) {
        throw new ValidationError("Body must be the { entity } envelope");
      }
      return validated;
    },
    handler: async (ctx) => {
      await runGuard("create", ctx);
      const created = await service.create((ctx.body as { entity: Record<string, unknown> }).entity);
      ctx.res.writeHead(201, { "Content-Type": "application/json" });
      ctx.res.end(extJsonStringify(created));
    },
  });

  push("duplicate", {
    method: "POST",
    path: `${base}/duplicate`,
    body: (raw) =>
      config.schemas?.duplicateBody
        ? config.schemas.duplicateBody(raw)
        : defaultDuplicateBody(raw),
    handler: async (ctx) => {
      await runGuard("duplicate", ctx);
      return service.duplicate((ctx.body as { uuids: string[] }).uuids);
    },
  });

  push("bulkDelete", {
    method: "POST",
    path: `${base}/bulk-delete`,
    body: (raw) => parseBulkItems(raw),
    handler: async (ctx) => {
      await runGuard("bulkDelete", ctx);
      return service.bulkDelete(ctx.body as Array<{ uuid: string; version: number }>);
    },
  });

  push("bulkRestore", {
    method: "POST",
    path: `${base}/bulk-restore`,
    body: (raw) => parseBulkItems(raw),
    handler: async (ctx) => {
      await runGuard("bulkRestore", ctx);
      return service.bulkRestore(ctx.body as Array<{ uuid: string; version: number }>);
    },
  });

  push("get", {
    method: "GET",
    path: `${base}/:uuid`,
    handler: async (ctx) => service.get(requireUuidParam(ctx)),
  });

  push("update", {
    method: "PUT",
    path: `${base}/:uuid`,
    body: (raw) => {
      const validated = config.schemas?.updateBody
        ? config.schemas.updateBody(raw)
        : (raw as { entity: Record<string, unknown> });
      if (!validated || typeof validated !== "object" || !("entity" in validated)) {
        throw new ValidationError("Body must be the { entity } envelope");
      }
      return validated;
    },
    handler: async (ctx) => {
      const uuid = requireUuidParam(ctx);
      await runGuard("update", ctx);
      return service.update(uuid, (ctx.body as { entity: Record<string, unknown> }).entity);
    },
  });

  push("purge", {
    method: "DELETE",
    path: `${base}/:uuid/purge`,
    handler: async (ctx) => {
      const uuid = requireUuidParam(ctx);
      await runGuard("purge", ctx);
      return service.purge(uuid, requireVersion(ctx.query));
    },
  });

  push("delete", {
    method: "DELETE",
    path: `${base}/:uuid`,
    handler: async (ctx) => {
      const uuid = requireUuidParam(ctx);
      await runGuard("delete", ctx);
      return service.delete(uuid, requireVersion(ctx.query));
    },
  });

  push("restore", {
    method: "POST",
    path: `${base}/:uuid/restore`,
    handler: async (ctx) => {
      const uuid = requireUuidParam(ctx);
      await runGuard("restore", ctx);
      return service.restore(uuid, requireVersion(ctx.query));
    },
  });

  push("audit", {
    method: "GET",
    path: `${base}/:uuid/audit`,
    handler: async (ctx) => {
      const uuid = requireUuidParam(ctx);
      const parsed = parseBracketQuery(ctx.query);
      const q = config.schemas?.auditQuery
        ? runValidator(config.schemas.auditQuery, parsed)
        : {
            page: Math.max(1, Number(parsed.page) || 1),
            limit: Math.min(50, Math.max(1, Number(parsed.limit) || 50)),
          };
      return service.audit(uuid, q.page, q.limit);
    },
  });

  return makeRpcRouter(routes);
}
