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
      const routeAccessErr = validateAccessKey(accessNs, rd["access"], `endpoints.nav.routes[${i}]`, "item");
      if (routeAccessErr) return routeAccessErr;
      declaredRoutes.set(route, kind);
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
