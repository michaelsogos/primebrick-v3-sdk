/**
 * derive-entity-nav — the facade wire: the SAME entity declarations that
 * build the routes also derive the module's navigation leaves, so an
 * entity can never be served-but-invisible again.
 *
 * Recognition is structural, never import-based (the SDK is dal-free):
 * the service instance carries the entity class's derived markers —
 * `relationFacet`/`dictFacet`/`tableName` are getters dal-pg exposes on
 * every DomainService.
 *
 *   service.relationFacet  → NEVER a leaf — bridge/edge entities (the
 *                            CRUD API stays for machine consumers; "not
 *                            consultable" means no standalone UI surface)
 *   service.dictFacet      → one `dict` leaf under the settings sibling —
 *                            the inline-editing vocabulary archetype
 *   otherwise              → standard list leaf at the module root +
 *                            `create` route when `permissions.create` is
 *                            declared (a read/audit-only entity derives
 *                            list-only by construction)
 *
 * Opt-out: `nav: false` on the decl — the entity keeps its routes but
 * contributes no leaf (the ONLY escape hatch; absence must be chosen).
 *
 * Ownership suppression: any module-authored route entry naming the
 * entity (root or sibling census) suppresses derivation FOR THAT ENTITY
 * — the author owns its surfaces (custom icons, default flags, remote
 * pages). Builtin contributions suppress through the same channel.
 */

import type { ModuleNavDeclaration, ModuleNavLink, PageRouteDeclaration } from "@primebrick/core";
import type { EntityRouteDecl } from "./service-routes.js";

export interface DeriveEntityNavOpts {
  /** Module code ("crm") — seeds the i18n label keys. */
  module_code: string;
  /** Entities whose leaves are already contributed elsewhere (builtins)
   *  — derivation never touches them. */
  suppress_entities?: ReadonlySet<string>;
}

function authoredEntities(nav: ModuleNavDeclaration): Set<string> {
  const owned = new Set<string>();
  for (const r of nav.routes ?? []) if (r.entity) owned.add(r.entity);
  for (const sib of nav.siblings ?? []) {
    for (const r of sib.routes ?? []) if (r.entity) owned.add(r.entity);
  }
  return owned;
}

/** Columns editable on a create surface — class-derived semantics decide,
 *  never authored placement: audit stamps (`audited`), DB-filled keys
 *  (`managed`) and read-only materializations (`kind`) are never client-
 *  supplied; `immutable` IS editable on create (it locks afterwards) so
 *  it stays. Ordered by the column's meta `order`. */
function createFormFields(decl: EntityRouteDecl): { key: string }[] {
  const columns = decl.meta?.columns;
  if (!columns) return [];
  // meta.columns is MetaColumn[] — an ARRAY. Object.entries on it yields
  // numeric index keys ("0"…"18") that drift-crash the form renderer
  // (prova del 9 2026-11-27: "declares field '18' but entity meta has no
  // such column"). The column identity is c.key, never the position.
  const uid = decl.meta?.uid;
  return columns
    .filter(
      (c) =>
        !c.audited &&
        !c.managed &&
        !c.kind &&
        !c.hidden &&
        c.key !== uid &&
        c.key !== "version",
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((c) => ({ key: c.key }));
}

export function deriveEntityNav(
  decls: readonly EntityRouteDecl[],
  nav: ModuleNavDeclaration | undefined,
  opts: DeriveEntityNavOpts,
): ModuleNavDeclaration | undefined {
  if (!nav || decls.length === 0) return nav;
  const primary = nav.route_prefixes[0];
  if (!primary) return nav;
  const owned = authoredEntities(nav);
  const suppressed = opts.suppress_entities ?? new Set<string>();

  const rootNav = [...nav.nav];
  const rootRoutes = [...(nav.routes ?? [])];
  const siblings = (nav.siblings ?? []).map((s) => ({ ...s, nav: [...s.nav], routes: [...(s.routes ?? [])] }));

  for (const decl of decls) {
    if ((decl as { nav?: false }).nav === false) continue;
    if (owned.has(decl.entityName) || suppressed.has(decl.entityName)) continue;
    const svc = decl.service as {
      relationFacet?: unknown;
      dictFacet?: unknown;
      tableName?: string;
    };
    if (svc.relationFacet !== undefined) continue;
    if (!svc.tableName) {
      throw new Error(
        `deriveEntityNav: entity "${decl.entityName}" exposes no service.tableName — ` +
          `the nav derivation builds leaf paths from it. Expose the getter (dal-pg DomainService does) ` +
          `or opt out explicitly with nav:false on the decl`,
      );
    }
    const table = svc.tableName;
    const isDict = svc.dictFacet !== undefined;

    if (isDict) {
      const settingsPrefix = `${primary}/settings`;
      let sib = siblings.find((s) => s.id === "settings");
      if (!sib) {
        sib = {
          id: "settings",
          label_key: `${opts.module_code}.settings.nav.label`,
          icon: "settings",
          route_prefixes: [settingsPrefix],
          nav: [],
          routes: [],
        };
        siblings.push(sib);
      }
      const href = `${settingsPrefix}/${table}`;
      // the label belongs to the ENTITY, never to its placement — one
      // canonical key shape (`<module>.<table>.nav`) everywhere, so the
      // seeds that already exist for every entity resolve with zero
      // duplication and a leaf never renames when it moves.
      const label_key = `${opts.module_code}.${table}.nav`;
      if (sib.nav.some((l) => l.id === table)) {
        throw new Error(
          `deriveEntityNav: dict leaf "${table}" collides with an authored sibling leaf — remove the hand-written declaration`,
        );
      }
      sib.nav.push({ id: table, label_key, href });
      (sib.routes ??= []).push({ route: href, kind: "dict", entity: decl.entityName, label_key });
      continue;
    }

    // Standard entity — list leaf at the module root; create when the
    // permission is declared (presence registers the route — the leaf
    // never outlives the surface it points at).
    if (!decl.permissions.list) continue;
    const label_key = `${opts.module_code}.${table}.nav`;
    const listHref = `${primary}/${table}`;
    if (rootNav.some((l) => l.id === table)) {
      throw new Error(
        `deriveEntityNav: list leaf "${table}" collides with an authored leaf — remove the hand-written declaration`,
      );
    }
    rootNav.push({ id: table, label_key, href: listHref });
    if (decl.permissions.create) {
      // The create leaf ALWAYS follows the route's fate (user-ratified
      // 2026-11-27): the route exists ⟺ the leaf exists. What impacts the
      // route impacts the leaf; the leaf-only opt-out never impacts the
      // route. Placement (user-ratified same day): POPOVER-ONLY — the
      // sidebar stays flat single-level, so the leaf is a flat sibling
      // flagged `sidebar: false` (the sidebar skips it, the popover
      // lists it). NOT nav_hidden: that channel is the server's
      // access-denied reveal list, computed per-user — never declared.
      rootNav.push({ id: `${table}-create`, label_key: `${opts.module_code}.${table}.nav.create`, href: `${listHref}/create`, sidebar: false });
    }
    rootRoutes.push({ route: listHref, kind: "list", entity: decl.entityName, label_key });

    if (decl.permissions.create) {
      const fields = createFormFields(decl);
      rootRoutes.push({
        route: `${listHref}/create`,
        kind: "create",
        entity: decl.entityName,
        label_key: `${opts.module_code}.${table}.nav.create`,
        page_props: { form: { fields } },
      });
    }
  }

  return {
    ...nav,
    nav: rootNav,
    routes: rootRoutes,
    ...(siblings.length ? { siblings } : {}),
  };
}
