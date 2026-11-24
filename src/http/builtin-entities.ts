/**
 * builtin-entities — the sdk side of the cross-package builtin-decl
 * registry.
 *
 * Built-in entity surfaces (e.g. the `sequence` registry) are mounted BY
 * CONSTRUCTION — never authored in a module's route declarations. The
 * decl factories are owned by dal-pg (they build real `DomainService`
 * instances over the shared entity classes); the SDK cannot import
 * dal-pg and dal-pg cannot import the SDK, so the factories travel
 * through a `Symbol.for`-keyed `globalThis` registry — the same seam
 * the lifecycle process-registry uses for hot-reload dedupe.
 *
 * Registration happens as a side effect of importing dal-pg (which every
 * service does in `db/dal.ts`), so the factories exist before
 * `makeServiceRoutes` evaluates the module-level route surface. The
 * `actor` primitive is injected by the SDK at mount — auth never crosses
 * the boundary.
 *
 * A consumer decl colliding with a builtin `entityName` is a BOOT
 * ERROR — builtins may only ever exist through this mount.
 */

import { requireActor } from "../auth/session-context.js";
import type { ModuleNavDeclaration } from "@primebrick/core";
import type { EntityRouteDecl } from "./service-routes.js";
import type { RpcRoute } from "./rpc-router.js";

export interface BuiltinDeclCtx {
  actor: () => string;
  /** The module's declared schema list (code const, [0] = owned) — carried
   *  through the ctx so builtin decls resolve their owned namespace from
   *  service identity, never env. */
  schemas: readonly string[];
}

interface BuiltinDeclFactory {
  id: string;
  make: (ctx: BuiltinDeclCtx) => Record<string, unknown>[];
  /** Governed RPC surface (e.g. `sequence-set`) — merged into
   *  makeServiceRoutes' `rpc` input so entity_op binding, OpenAPI and
   *  mounting treat builtin routes exactly like module-authored ones. */
  rpc?: (ctx: BuiltinDeclCtx) => Record<string, unknown>[];
  nav?: (ctx: BuiltinDeclCtx) => BuiltinNavContribution;
}

/** A builtin leaf contributed under a sibling module node — composed
 *  into the module's nav by `mergeBuiltinNav`. The shape is
 *  registry-structural (dal-pg emits it; core types stay on this side). */
export interface BuiltinNavContribution {
  sibling_id: string;
  sibling_label_key: string;
  sibling_icon: string;
  leaf_id: string;
  label_key: string;
  icon: string;
  entity: string;
}

const REGISTRY_KEY = Symbol.for("primebrick.builtin-entity-decl-factories");

/** Built-in decls from every registered provider (dal-pg today).
 *  Empty when no provider is loaded (sdk-only tests, no-DB services). */
export function builtinEntityDecls(schemas: readonly string[]): EntityRouteDecl[] {
  const g = globalThis as Record<symbol, Map<string, BuiltinDeclFactory> | undefined>;
  const reg = g[REGISTRY_KEY];
  if (!reg) return [];
  const ctx: BuiltinDeclCtx = { actor: () => requireActor(), schemas };
  return [...reg.values()].flatMap((f) => f.make(ctx)) as unknown as EntityRouteDecl[];
}

/** Built-in RPC routes from every registered provider — bare `RpcRoute[]`
 *  entries, ready to merge into makeServiceRoutes' `rpc` input. Empty
 *  when no provider is loaded or no builtin declares an RPC surface. */
export function builtinRpcRoutes(schemas: readonly string[]): RpcRoute[][] {
  const g = globalThis as Record<symbol, Map<string, BuiltinDeclFactory> | undefined>;
  const reg = g[REGISTRY_KEY];
  if (!reg) return [];
  const ctx: BuiltinDeclCtx = { actor: () => requireActor(), schemas };
  return [...reg.values()].flatMap((f) =>
    f.rpc ? [f.rpc(ctx) as unknown as RpcRoute[]] : [],
  );
}

/** Builtin nav contributions from every registered provider. */
export function builtinNavContributions(schemas: readonly string[]): BuiltinNavContribution[] {
  const g = globalThis as Record<symbol, Map<string, BuiltinDeclFactory> | undefined>;
  const reg = g[REGISTRY_KEY];
  if (!reg) return [];
  const ctx: BuiltinDeclCtx = { actor: () => requireActor(), schemas };
  return [...reg.values()].flatMap((f) => (f.nav ? [f.nav(ctx)] : []));
}

/** Merge builtin nav contributions into the module's self-declaration —
 *  BY CONSTRUCTION, same contract as the entity-route mount:
 *
 *  - the contribution's sibling is found-or-created under the module's
 *    primary route_prefix (`/<prefix>/<sibling_id>`);
 *  - leaf + route append LAST inside the sibling's arrays — array
 *    position is the ordering at every nav level, so builtins always
 *    sort after every module-authored entry;
 *  - a module-authored leaf or route colliding with the contribution is
 *    a BOOT ERROR — builtins may only ever exist through this mount.
 *
 *  Modules without a nav declaration get none (no route_prefixes to
 *  nest under — no surface to hang on). */
export function mergeBuiltinNav(nav: ModuleNavDeclaration | undefined, schemas: readonly string[]): ModuleNavDeclaration | undefined {
  const contributions = builtinNavContributions(schemas);
  if (!nav || contributions.length === 0) return nav;
  const primary = nav.route_prefixes[0];
  const siblings = [...(nav.siblings ?? [])];
  for (const c of contributions) {
    let sib = siblings.find((s) => s.id === c.sibling_id);
    if (!sib) {
      sib = {
        id: c.sibling_id,
        label_key: c.sibling_label_key,
        icon: c.sibling_icon,
        route_prefixes: [`${primary}/${c.sibling_id}`],
        nav: [],
        routes: [],
      };
      siblings.push(sib);
    }
    const taken =
      sib.nav.some((l) => l.id === c.leaf_id) ||
      (sib.routes ?? []).some((r) => r.entity === c.entity) ||
      nav.nav.some((l) => l.id === c.leaf_id);
    if (taken) {
      throw new Error(
        `createMicroservice: builtin nav leaf "${c.leaf_id}" collides with a module-authored declaration — ` +
          `builtin entities mount by construction and may never be authored`,
      );
    }
    const href = `${primary}/${c.sibling_id}/${c.leaf_id}`;
    sib.nav.push({ id: c.leaf_id, label_key: c.label_key, href, icon: c.icon });
    // `list` = the host-rendered EntityTablePage archetype (the standard
    // list surface — row/bulk custom CTAs from entity_op synthesis live
    // there; `dict` is the settings-dictionary anatomy, not a registry).
    (sib.routes ??= []).push({ route: href, kind: "list", entity: c.entity, label_key: c.label_key });
  }
  return { ...nav, siblings };
}
