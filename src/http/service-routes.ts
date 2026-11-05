/**
 * Service routes factory — ONE declaration produces BOTH the request
 * routers and the `/api/v1/openapi.json` spec handler.
 *
 * Why this exists: the spec used to be composed by hand
 * (`entityCrudSpec(entity, { ops: [...] })` next to
 * `makeEntityRouter({ permissions: {...} })`) — the same operation set
 * declared twice, free to drift. Here the entity's `permissions`/`meta`/
 * `duplicate` fields ARE the spec input: every op listed in the spec is
 * the op the router registered, by construction.
 *
 *   routeHandler: makeServiceRoutes({
 *     info: { title: "Webhook", version: "1.0.0" },
 *     entities: [{ entityName: "provider", service, permissions, meta, spec: { label } }],
 *     rpc: [WEBHOOK_ROUTES],
 *   })
 *
 * Returns a factory-branded RouteHandler — pass it directly to
 * `createMicroservice({ routeHandler })` or compose it further.
 */

import {
  makeEntityRouter,
  type EntityCustomOp,
  type EntityAction,
  type EntityRouterConfig,
} from "./entity-router.js";
import {
  buildOpenApiSpec,
  entityCrudSpec,
  makeOpenApiHandler,
  rpcSpec,
  type EntityCrudOp,
  type JsonSchema,
} from "./openapi.js";
import {
  composeRouteHandlers,
  makeRpcRouter,
  type RpcRoute,
  type RpcRouterDeps,
  type RouteHandler,
} from "./rpc-router.js";

/** Entity declaration for `makeServiceRoutes`. `spec` only shapes the
 *  generated OpenAPI block — the router ignores it. Operation set is
 *  derived from `permissions`/`meta`/`duplicate`, never restated. */
export interface EntityRouteDecl<TEntity = unknown> extends EntityRouterConfig<TEntity> {
  spec?: {
    /** OpenAPI tag grouping (default `<entity>s`). */
    tag?: string;
    /** Human label in summaries (default = entityName). */
    label?: string;
    /** Response schema for the list op. */
    listResponse?: JsonSchema;
  };
}

/** The composed route handler returned by `makeServiceRoutes` — carries
 *  the built OpenAPI document so docs-pack builds (`buildDocsPack`) can
 *  embed `handler.spec` without a second spec declaration. */
export type ServiceRoutesHandler = RouteHandler & {
  readonly spec: Record<string, unknown>;
};

export interface ServiceRoutesInput {
  /** OpenAPI document info — title is required, version recommended. */
  info: { title: string; version: string; description?: string };
  /** Emitted as `servers[0].url` when present. */
  serverUrl?: string;
  /** Extra top-level OpenAPI tags. */
  tags?: { name: string; description?: string }[];
  /** Entity CRUD routers — routes AND spec derived from one config. */
  entities?: EntityRouteDecl[];
  /** RPC route tables — one makeRpcRouter per entry; `openapi` metadata
   *  on each route feeds `rpcSpec`. An entry may be a bare `RpcRoute[]`
   *  or `{ routes, deps }` when the router needs wiring (e.g. apiKeyPort). */
  rpc?: (RpcRoute[] | { routes: RpcRoute[]; deps?: RpcRouterDeps })[];
}

// Router registration semantics (mirrored from entity-router.ts):
//   enabled(a) = permissions[a] — for `duplicate`, presence is implied by
//   `duplicate !== false` (the conventional `<entity>.duplicate.bulk`
//   permission is auto-assigned). `meta` additionally requires `cfg.meta`.
const OP_ORDER: EntityAction[] = [
  "meta", "list", "export", "get", "create", "update", "delete",
  "purge", "restore", "audit", "duplicate", "bulkDelete", "bulkRestore",
];
const ACTION_TO_SPEC_OP: Partial<Record<EntityAction, EntityCrudOp>> = {
  bulkDelete: "bulk_delete",
  bulkRestore: "bulk_restore",
};

function specOpsFor(cfg: EntityRouterConfig): EntityCrudOp[] {
  const enabled = (a: EntityAction): boolean => {
    if (a === "duplicate") {
      return cfg.permissions.duplicate !== undefined || cfg.duplicate !== false;
    }
    return cfg.permissions[a] !== undefined;
  };
  const ops: EntityCrudOp[] = [];
  for (const a of OP_ORDER) {
    if (a === "meta" && !cfg.meta) continue;
    if (!enabled(a)) continue;
    ops.push(ACTION_TO_SPEC_OP[a] ?? (a as EntityCrudOp));
  }
  return ops;
}

/**
 * Build a service's full route surface from one declaration: entity CRUD
 * routers, RPC routers, and the OpenAPI spec handler — spec paths derived
 * from the same route metadata, so a route that exists but isn't
 * documented (or vice versa) is impossible.
 */
export function makeServiceRoutes(input: ServiceRoutesInput): ServiceRoutesHandler {
  const handlers: RouteHandler[] = [];
  const paths: Record<string, unknown> = {};

  // Custom entity ops — RPC routes that declare `entity_op` are attached
  // to the target entity's `meta.actions` with their declared endpoint.
  // Fail-fast at construction (enforcement, not verification):
  //   - entity_op naming an entity with no decl → boot error
  //   - duplicate op on the same entity → boot error
  //   - row_custom_actions/bulk_custom_actions action_name without a
  //     declared op → boot error (dead CTA is a config bug, not a runtime
  //     501 surprise)
  const entityDecls = input.entities ?? [];
  const customOps = new Map<string, EntityCustomOp[]>();
  for (const entry of input.rpc ?? []) {
    const routes = Array.isArray(entry) ? entry : entry.routes;
    for (const r of routes) {
      if (!r.entity_op) continue;
      const { entity, op } = r.entity_op;
      if (!entityDecls.some((d) => d.entityName === entity)) {
        throw new Error(
          `makeServiceRoutes: route ${r.method} ${r.path} declares entity_op ` +
            `on "${entity}" which has no entity decl — the op can never be reached`,
        );
      }
      const list = customOps.get(entity) ?? [];
      if (list.some((c) => c.op === op)) {
        throw new Error(
          `makeServiceRoutes: duplicate custom op "${op}" on entity "${entity}" ` +
            `(${r.method} ${r.path})`,
        );
      }
      list.push({ op, method: r.method, path: r.path, permissions: r.permissions ?? [] });
      customOps.set(entity, list);
    }
  }
  for (const decl of entityDecls) {
    const declaredOps = new Set((customOps.get(decl.entityName) ?? []).map((c) => c.op));
    const chrome = [
      ...(decl.meta?.table?.row_custom_actions ?? []),
      ...(decl.meta?.table?.bulk_custom_actions ?? []),
    ];
    for (const cta of chrome) {
      if (!declaredOps.has(cta.action_name)) {
        throw new Error(
          `makeServiceRoutes: entity "${decl.entityName}" declares ` +
            `custom action "${cta.action_name}" in meta.table with no backing ` +
            `route — declare entity_op: { entity: "${decl.entityName}", op: ` +
            `"${cta.action_name}" } on its RpcRoute`,
        );
      }
    }
  }

  for (const decl of entityDecls) {
    const ops = customOps.get(decl.entityName);
    handlers.push(makeEntityRouter(ops ? { ...decl, custom_ops: ops } : decl));
    Object.assign(
      paths,
      entityCrudSpec(decl.entityName, {
        ops: specOpsFor(decl),
        ...(decl.spec?.tag ? { tag: decl.spec.tag } : {}),
        ...(decl.spec?.label ? { label: decl.spec.label } : {}),
        ...(decl.spec?.listResponse ? { listResponse: decl.spec.listResponse } : {}),
      }),
    );
  }

  for (const entry of input.rpc ?? []) {
    const routes = Array.isArray(entry) ? entry : entry.routes;
    const deps = Array.isArray(entry) ? {} : (entry.deps ?? {});
    handlers.push(makeRpcRouter(routes, deps));
    Object.assign(paths, rpcSpec(routes));
  }

  const spec = buildOpenApiSpec({
    info: input.info,
    ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    paths,
  });
  handlers.push(makeOpenApiHandler(spec));

  return Object.assign(composeRouteHandlers(...handlers), { spec });
}
