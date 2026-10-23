/**
 * Service nav-declaration contract — validator + the ONLY path builder.
 *
 * A module's `service.register` payload carries `endpoints.nav`
 * ({route_prefixes, nav, routes}) — validated HERE at enrollment so a
 * malformed declaration is rejected before it can poison `/modules`.
 *
 * Conventions enforced mechanically — error today, error tomorrow:
 *
 * - R1 plural list leaf — `routes[].kind === 'list'` must end in a plural
 *   segment (`pluralize.isPlural`). `/system/job/job-schedules` ✓,
 *   `/system/job` ✗. Entities are singular, their pages/routes plural.
 * - R2 nav leaf — a leaf nav href that resolves to a declared `list`
 *   route inherits R1; a href resolving to another kind is exempt; a href
 *   resolving to NOTHING must itself be plural or in
 *   `SINGULAR_NAV_ALLOWLIST` (extending it is a deliberate code change).
 * - R3 create/detail leaf — `kind === 'create'` → leaf is exactly
 *   `create`; `kind === 'detail'` → leaf is a `[param]` segment.
 *   `create` is THE convention — `/new` is rejected.
 *
 * Path construction is never a literal: {@link entityPaths} derives
 * list/create/detail from the leaf — modules compute, they don't write.
 */

import pluralize from "pluralize";

import { isAccessKey } from "../auth/access.js";
import { extJsonStringify } from "../json/ext-json.js";
import { allowedKeyNamespaces, keyNamespaceOf } from "@primebrick/core";

export const PAGE_ROUTE_KINDS = new Set(["list", "detail", "create", "page"]);

/**
 * Leaf nav segments allowed to stay singular when they resolve to no
 * declared route — kept deliberately tiny; extending it is an explicit
 * diff, never an accident.
 */
export const SINGULAR_NAV_ALLOWLIST = new Set<string>(["profile"]);

/**
 * The ONLY constructor of entity route paths — modules declare routes
 * through this builder instead of writing string literals, so the
 * `/{list}` / `/{list}/create` / `/{list}/[param]` shape can never
 * diverge by hand.
 */
export function entityPaths(
  prefix: string,
  listLeaf: string,
  detailParam = "uuid",
): { list: string; create: string; detail: string } {
  const base = `${prefix.replace(/\/+$/, "")}/${listLeaf}`;
  return { list: base, create: `${base}/create`, detail: `${base}/[${detailParam}]` };
}

/** Last static segment of a route path — `null` for param segments. */
function leafOf(path: string): string | null {
  const leaf = path.split("/").filter(Boolean).pop() ?? "";
  return leaf.startsWith("[") ? null : leaf;
}

function isPluralLeaf(leaf: string): boolean {
  return pluralize.isPlural(leaf);
}

const DETAIL_LEAF_RE = /^\[[a-zA-Z0-9_]+\]$/;

/**
 * Section `source` grammar — `remote:<export>` names a mount export of the
 * page's own chunk; `host:<key>` names a host-registered section component.
 * The name part follows the JS identifier rule on both sides so a remote
 * source is always callable and a host key always registry-shaped.
 */
const SECTION_SOURCE_RE = /^(remote|host):[A-Za-z_$][\w$]*$/;

/**
 * Validate `page_props.layout` — the section-composition contract. Grid is
 * the single layout archetype: `columns`/`rows`/`gap` are CSS strings,
 * `sections` is a non-empty ordered list whose `source` selects the mount
 * target and `span`/`col`/`row` place it inside the grid.
 */
function validatePageLayout(layout: unknown, path: string): string | null {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    return `${path}: layout must be an object {columns?, rows?, gap?, sections}`;
  }
  const l = layout as Record<string, unknown>;
  for (const k of ["columns", "rows", "gap"] as const) {
    if (l[k] !== undefined && typeof l[k] !== "string") {
      return `${path}.${k}: must be a CSS string (e.g. 'repeat(3, 1fr)', '280px 1fr', '1.5rem')`;
    }
  }
  if (!Array.isArray(l["sections"]) || (l["sections"] as unknown[]).length === 0) {
    return `${path}.sections: must be a non-empty array of section declarations`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < (l["sections"] as unknown[]).length; i++) {
    const s = (l["sections"] as unknown[])[i];
    const sp = `${path}.sections[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      return `${sp}: section must be an object {id, source, props?, span?, col?, row?}`;
    }
    const sd = s as Record<string, unknown>;
    if (typeof sd["id"] !== "string" || !sd["id"]) return `${sp}: missing section id`;
    if (seen.has(sd["id"] as string)) return `${sp}: duplicate section id '${sd["id"]}'`;
    seen.add(sd["id"] as string);
    if (typeof sd["source"] !== "string" || !SECTION_SOURCE_RE.test(sd["source"] as string)) {
      return `${sp} ('${sd["id"]}'): source must be 'remote:<export>' or 'host:<key>' (JS-identifier name)`;
    }
    if (sd["props"] !== undefined && (typeof sd["props"] !== "object" || sd["props"] === null || Array.isArray(sd["props"]))) {
      return `${sp} ('${sd["id"]}'): props must be a plain object`;
    }
    for (const k of ["span", "col", "row"] as const) {
      if (sd[k] !== undefined && (!Number.isInteger(sd[k]) || (sd[k] as number) < 1)) {
        return `${sp} ('${sd["id"]}'): ${k} must be a positive integer (grid placement)`;
      }
    }
  }
  return null;
}

/**
 * A module's access-axis namespace — `access.{app}.{module}` with the
 * `part_of === code` collapse (same rule as the URL prefix). Declared
 * `access` keys on the nav declaration MUST live under it: job can only
 * gate `access.system.job.*`, never `access.system.settings.*`.
 */
export function accessNamespace(code: string, partOf: string): string {
  return partOf === code ? `access.${code}` : `access.${partOf}.${code}`;
}

function validateAccessKey(
  ns: string,
  value: unknown,
  path: string,
  field: "module" | "item",
): string | null {
  if (value === undefined) return null;
  if (!isAccessKey(value)) {
    return `${path}: access must be an 'access.{app}.{module}[.{page}]' key`;
  }
  if (field === "module" && value !== ns) {
    return `${path}: module-level access must be exactly '${ns}'`;
  }
  if (field === "item" && value !== ns && !(value as string).startsWith(ns + ".")) {
    return `${path}: access '${value}' is outside the module access namespace '${ns}.*'`;
  }
  return null;
}

function validateNavLink(code: string, accessNs: string, link: unknown, path: string): string | null {
  if (!link || typeof link !== "object" || Array.isArray(link)) {
    return `endpoints.nav.nav ${path}: link must be an object`;
  }
  const l = link as Record<string, unknown>;
  if (typeof l["id"] !== "string" || !l["id"]) return `endpoints.nav.nav ${path}: missing link id`;
  if (typeof l["label_key"] !== "string" || !l["label_key"]) {
    return `endpoints.nav.nav ${path} ('${l["id"]}'): missing label_key`;
  }
  const ns = keyNamespaceOf(l["label_key"] as string);
  if (ns === null || !allowedKeyNamespaces(code).has(ns)) {
    return `endpoints.nav.nav ${path} ('${l["id"]}'): label_key '${l["label_key"]}' is outside the module namespace '${code}.*' and CORE namespaces (app.*, system.*)`;
  }
  if (typeof l["href"] !== "string" || !(l["href"] as string).startsWith("/")) {
    return `endpoints.nav.nav ${path} ('${l["id"]}'): href must be an absolute FE path`;
  }
  if (l["icon"] !== undefined && typeof l["icon"] !== "string") {
    return `endpoints.nav.nav ${path} ('${l["id"]}'): icon must be a lucide name string`;
  }
  const accessErr = validateAccessKey(accessNs, l["access"], `endpoints.nav.nav ${path} ('${l["id"]}')`, "item");
  if (accessErr) return accessErr;
  if (l["children"] !== undefined) {
    if (!Array.isArray(l["children"])) {
      return `endpoints.nav.nav ${path} ('${l["id"]}'): children must be an array`;
    }
    for (let i = 0; i < (l["children"] as unknown[]).length; i++) {
      const err = validateNavLink(code, accessNs, (l["children"] as unknown[])[i], `${path}.children[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/** Recursively collect every leaf href in the nav tree. */
function collectNavHrefs(nav: unknown[], out: string[] = []): string[] {
  for (const item of nav) {
    const l = item as Record<string, unknown>;
    if (typeof l["href"] === "string") out.push(l["href"]);
    if (Array.isArray(l["children"])) collectNavHrefs(l["children"] as unknown[], out);
  }
  return out;
}

/**
 * Validate a service's self-declared `endpoints.nav` contract — called at
 * `service.register` time so a malformed declaration is REJECTED at
 * enrollment and can never poison /modules or the routes census.
 * Returns the first error string, or null when valid.
 *
 * `partOf` is the module's declared ROOT LEVEL — its primary route prefix
 * is derived, never free-chosen: `/{partOf}/{code}`. When the module IS its
 * own root (`partOf === code`, e.g. crm) the segment collapses to `/{code}`
 * — `/crm/customers`, not `/crm/crm/customers`.
 * `route_prefixes` must CONTAIN that primary prefix and may add EXTRA root
 * memberships in the `/{root}/{code}` shape only — a module with a foot in
 * two apps keeps its code as the URL's second segment
 * (`/system/crm/pipeline` = a crm page inside the System app), so
 * longest-prefix ownership keeps resolving module and breadcrumb.
 * Single-segment extras and foreign-code segments are rejected.
 * Every nav href / routes entry must live under SOME declared prefix.
 */
export function validateNavDeclaration(code: string, decl: unknown, partOf: string): string | null {
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
    return "endpoints.nav must be an object {route_prefixes, nav, routes?}";
  }
  const d = decl as Record<string, unknown>;
  const modulePrefix = partOf === code ? `/${code}` : `/${partOf}/${code}`;
  if (!Array.isArray(d["route_prefixes"]) || d["route_prefixes"].length === 0) {
    return "endpoints.nav.route_prefixes must be a non-empty array of FE path prefixes";
  }
  const prefixes: string[] = [];
  for (const p of d["route_prefixes"] as unknown[]) {
    if (typeof p !== "string" || !p.startsWith("/")) {
      return `endpoints.nav.route_prefixes: every prefix must be an absolute FE path (got ${extJsonStringify(p)})`;
    }
    if (p === modulePrefix) {
      prefixes.push(p);
      continue;
    }
    const segs = (p as string).split("/").filter(Boolean);
    if (segs.length !== 2 || segs[1] !== code) {
      return `endpoints.nav.route_prefixes: extra prefix '${p}' must be '/<root>/${code}' — the module code stays the URL's second segment (primary prefix '${modulePrefix}' is always required)`;
    }
    prefixes.push(p);
  }
  if (!prefixes.includes(modulePrefix)) {
    return `endpoints.nav.route_prefixes: module '${code}' (part_of='${partOf}') must declare its primary prefix '${modulePrefix}'`;
  }
  const underAny = (p: string) => prefixes.some((px) => p === px || p.startsWith(px + "/"));
  const accessNs = accessNamespace(code, partOf);
  const moduleAccessErr = validateAccessKey(accessNs, d["access"], "endpoints.nav.access", "module");
  if (moduleAccessErr) return moduleAccessErr;
  if (!Array.isArray(d["nav"])) {
    return "endpoints.nav.nav must be an array of {id,label_key,href} links";
  }
  for (let i = 0; i < (d["nav"] as unknown[]).length; i++) {
    const err = validateNavLink(code, accessNs, (d["nav"] as unknown[])[i], `[${i}]`);
    if (err) return err;
    const href = ((d["nav"] as unknown[])[i] as Record<string, unknown>)["href"] as string;
    if (!underAny(href)) {
      return `endpoints.nav.nav[${i}]: href '${href}' is outside the module prefixes ${extJsonStringify(prefixes)}`;
    }
  }
  const declaredRoutes = new Map<string, string>();
  if (d["routes"] !== undefined) {
    if (!Array.isArray(d["routes"])) return "endpoints.nav.routes must be an array of route declarations";
    for (let i = 0; i < (d["routes"] as unknown[]).length; i++) {
      const r = (d["routes"] as unknown[])[i];
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        return `endpoints.nav.routes[${i}]: route declaration must be an object`;
      }
      const rd = r as Record<string, unknown>;
      if (typeof rd["route"] !== "string" || !(rd["route"] as string).startsWith("/")) {
        return `endpoints.nav.routes[${i}]: route must be an absolute FE path`;
      }
      const route = rd["route"] as string;
      if (!underAny(route)) {
        return `endpoints.nav.routes[${i}]: route '${route}' is outside the module prefixes ${extJsonStringify(prefixes)}`;
      }
      if (typeof rd["kind"] !== "string" || !PAGE_ROUTE_KINDS.has(rd["kind"] as string)) {
        return `endpoints.nav.routes[${i}]: kind must be one of ${[...PAGE_ROUTE_KINDS].join("|")}`;
      }
      const kind = rd["kind"] as string;
      const leaf = leafOf(route);
      const rawLeaf = route.split("/").filter(Boolean).pop() ?? "";
      // R1 — list pages are plural: entities are singular, their routes
      // are the plural table/page surface (`/customers`, `/job-schedules`).
      if (kind === "list" && leaf !== null && !isPluralLeaf(leaf)) {
        return `endpoints.nav.routes[${i}]: list route '${route}' must end in a plural segment (got '${leaf}') — convention: entities singular, pages/routes plural`;
      }
      // R3 — create/detail shapes are derived, never free-chosen:
      // `create` leaf is THE convention; detail leaf is a [param].
      if (kind === "create" && leaf !== "create") {
        return `endpoints.nav.routes[${i}]: create route '${route}' must end in '/create' (the single convention — '/new' is rejected)`;
      }
      if (kind === "detail" && !DETAIL_LEAF_RE.test(rawLeaf)) {
        return `endpoints.nav.routes[${i}]: detail route '${route}' must end in a '[param]' segment (got '${rawLeaf}')`;
      }
      if (rd["component_url"] !== undefined && typeof rd["component_url"] !== "string") {
        return `endpoints.nav.routes[${i}]: component_url must be a string`;
      }
      if (rd["page_props"] !== undefined) {
        if (!rd["page_props"] || typeof rd["page_props"] !== "object" || Array.isArray(rd["page_props"])) {
          return `endpoints.nav.routes[${i}]: page_props must be an object`;
        }
        const pp = rd["page_props"] as Record<string, unknown>;
        if (pp["layout"] !== undefined) {
          const layoutErr = validatePageLayout(pp["layout"], `endpoints.nav.routes[${i}].page_props.layout`);
          if (layoutErr) return layoutErr;
        }
      }
      const routeAccessErr = validateAccessKey(accessNs, rd["access"], `endpoints.nav.routes[${i}]`, "item");
      if (routeAccessErr) return routeAccessErr;
      declaredRoutes.set(route, kind);
    }
  }
  // Sheets — remote `mountSheet` panels owned by this module. The engine is
  // host-side; the declaration only publishes the chunk + chrome hints.
  // Keys are module-namespaced (`<code>.<name>`) so two services can never
  // collide on an open-sheet address.
  if (d["sheets"] !== undefined) {
    if (!Array.isArray(d["sheets"])) return "endpoints.nav.sheets must be an array of sheet declarations";
    const seen = new Set<string>();
    for (let i = 0; i < (d["sheets"] as unknown[]).length; i++) {
      const s = (d["sheets"] as unknown[])[i];
      const sp = `endpoints.nav.sheets[${i}]`;
      if (!s || typeof s !== "object" || Array.isArray(s)) {
        return `${sp}: sheet declaration must be an object`;
      }
      const sd = s as Record<string, unknown>;
      if (typeof sd["key"] !== "string" || !sd["key"]) {
        return `${sp}: missing key`;
      }
      const key = sd["key"] as string;
      if (!key.startsWith(`${code}.`) || !/^[a-z][a-z0-9_]*\.[A-Za-z][A-Za-z0-9_$]*$/.test(key)) {
        return `${sp}: key '${key}' must be '<module>.<name>' — the '${code}.' namespace prefix is mandatory so services can never collide`;
      }
      if (seen.has(key)) return `${sp}: duplicate sheet key '${key}'`;
      seen.add(key);
      if (typeof sd["component_url"] !== "string" || !(sd["component_url"] as string).startsWith("/ws/")) {
        return `${sp} ('${key}'): component_url must be a '/ws/<service>/…' module-assets path`;
      }
      if (sd["component_format"] !== undefined && sd["component_format"] !== "esm-mount") {
        return `${sp} ('${key}'): component_format must be 'esm-mount'`;
      }
      if (sd["integrity"] !== undefined && typeof sd["integrity"] !== "string") {
        return `${sp} ('${key}'): integrity must be a string`;
      }
      if (sd["label_key"] !== undefined) {
        const ns = keyNamespaceOf(sd["label_key"] as string);
        if (ns === null || !allowedKeyNamespaces(code).has(ns)) {
          return `${sp} ('${key}'): label_key '${sd["label_key"]}' is outside the module namespace '${code}.*' and CORE namespaces`;
        }
      }
      if (sd["default_options"] !== undefined) {
        const o = sd["default_options"];
        if (!o || typeof o !== "object" || Array.isArray(o)) {
          return `${sp} ('${key}'): default_options must be an object {side?, modal?, content_class?}`;
        }
        const od = o as Record<string, unknown>;
        if (od["side"] !== undefined && od["side"] !== "left" && od["side"] !== "right") {
          return `${sp} ('${key}'): default_options.side must be 'left' or 'right'`;
        }
        if (od["modal"] !== undefined && typeof od["modal"] !== "boolean") {
          return `${sp} ('${key}'): default_options.modal must be a boolean`;
        }
        if (od["content_class"] !== undefined && typeof od["content_class"] !== "string") {
          return `${sp} ('${key}'): default_options.content_class must be a string`;
        }
      }
      const sheetAccessErr = validateAccessKey(accessNs, sd["access"], sp, "item");
      if (sheetAccessErr) return sheetAccessErr;
    }
  }
  // R2 — every leaf nav href must resolve to a DECLARED route (the census
  // already requires declaring every path). A link to a `list` route is
  // plural-checked at R1; to any other kind is fine; a link resolving to
  // nothing must be plural or explicitly allowlisted — otherwise a
  // singular-looking page can slip in undeclared.
  for (const href of collectNavHrefs(d["nav"] as unknown[])) {
    const kind = declaredRoutes.get(href);
    if (kind !== undefined) continue;
    const leaf = leafOf(href);
    if (leaf === null) continue;
    if (!isPluralLeaf(leaf) && !SINGULAR_NAV_ALLOWLIST.has(leaf)) {
      return `endpoints.nav.nav: href '${href}' resolves to no declared route and its leaf '${leaf}' is neither plural nor allowlisted — declare the route or fix the leaf`;
    }
  }
  return null;
}
