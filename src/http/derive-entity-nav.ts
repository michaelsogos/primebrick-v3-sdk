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
 * Derivation is TOTAL and unconditional (user-ratified 2026-11-27): an
 * authored leaf is a COSMETIC override carrier only — icon/label/order/
 * default merge onto the derived leaf by href, they NEVER suppress the
 * autowire, NEVER change a route, NEVER change a page kind. Nothing in
 * any module is non-standard because someone wanted a custom icon.
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
  const suppressed = opts.suppress_entities ?? new Set<string>();

  const rootNav = [...nav.nav];
  const rootRoutes = [...(nav.routes ?? [])];
  const siblings = (nav.siblings ?? []).map((s) => ({ ...s, nav: [...s.nav], routes: [...(s.routes ?? [])] }));

  for (const decl of decls) {
    if ((decl as { nav?: false }).nav === false) continue;
    if (suppressed.has(decl.entityName)) continue;
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
      if (!sib.nav.some((l) => l.href === href)) {
        sib.nav.push({ id: table, label_key, href });
      }
      (sib.routes ??= []).push({ route: href, kind: "dict", entity: decl.entityName, label_key });
      continue;
    }

    // Standard entity — list leaf at the module root; create when the
    // permission is declared (presence registers the route — the leaf
    // never outlives the surface it points at).
    if (!decl.permissions.list) continue;
    const label_key = `${opts.module_code}.${table}.nav`;
    const listHref = `${primary}/${table}`;
    if (!rootNav.some((l) => l.href === listHref)) {
      rootNav.push({ id: table, label_key, href: listHref });
    }
    if (decl.permissions.create) {
      // The create leaf ALWAYS follows the route's fate (user-ratified
      // 2026-11-27): the route exists ⟺ the leaf exists. What impacts the
      // route impacts the leaf; the leaf-only opt-out never impacts the
      // route. Placement (user-ratified same day): POPOVER-ONLY — the
      // sidebar stays flat single-level, so the leaf is a flat sibling
      // flagged `sidebar: false` (the sidebar skips it, the popover
      // lists it). NOT nav_hidden: that channel is the server's
      // access-denied reveal list, computed per-user — never declared.
      const createHrefNav = `${listHref}/create`;
      const derivedCreateLeaf = { id: `${table}-create`, label_key: `${opts.module_code}.${table}.nav.create`, href: createHrefNav, sidebar: false as boolean | undefined };
      const authoredIdx = rootNav.findIndex((l) => l.href === createHrefNav);
      if (authoredIdx >= 0) {
        // Cosmetic merge (user-ratified 2026-11-27): the authored leaf contributes
        // ONLY cosmetics — icon/label_key/order/default. The structure is the
        // derivation's own: id, href, and sidebar:false (popover-only) are never
        // overridable — an icon can never rewrite placement.
        const a = rootNav[authoredIdx];
        rootNav[authoredIdx] = {
          ...derivedCreateLeaf,
          ...(a.label_key ? { label_key: a.label_key } : {}),
          ...(a.icon ? { icon: a.icon } : {}),
          ...(a.order !== undefined ? { order: a.order } : {}),
          ...(a.default !== undefined ? { default: a.default } : {}),
        };
      } else {
        rootNav.push(derivedCreateLeaf);
      }
    }
    if (!rootRoutes.some((r) => r.route === listHref)) {
      rootRoutes.push({ route: listHref, kind: "list", entity: decl.entityName, label_key });
    }

    if (decl.permissions.create) {
      const createHref = `${listHref}/create`;
      if (!rootRoutes.some((r) => r.route === createHref)) {
        const fields = createFormFields(decl);
        rootRoutes.push({
          route: createHref,
          kind: "create",
          entity: decl.entityName,
          label_key: `${opts.module_code}.${table}.nav.create`,
          page_props: { form: { fields } },
        });
      }
    }
  }

  return {
    ...nav,
    nav: rootNav,
    routes: rootRoutes,
    ...(siblings.length ? { siblings } : {}),
  };
}
