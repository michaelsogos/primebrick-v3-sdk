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
import type { EntityRouteDecl } from "./service-routes.js";

export interface BuiltinDeclCtx {
  actor: () => string;
}

interface BuiltinDeclFactory {
  id: string;
  make: (ctx: BuiltinDeclCtx) => Record<string, unknown>[];
}

const REGISTRY_KEY = Symbol.for("primebrick.builtin-entity-decl-factories");

/** Built-in decls from every registered provider (dal-pg today).
 *  Empty when no provider is loaded (sdk-only tests, no-DB services). */
export function builtinEntityDecls(): EntityRouteDecl[] {
  const g = globalThis as Record<symbol, Map<string, BuiltinDeclFactory> | undefined>;
  const reg = g[REGISTRY_KEY];
  if (!reg) return [];
  const ctx: BuiltinDeclCtx = { actor: () => requireActor() };
  return [...reg.values()].flatMap((f) => f.make(ctx)) as unknown as EntityRouteDecl[];
}
