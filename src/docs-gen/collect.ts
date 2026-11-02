/**
 * docs-gen — fact collection + normalization.
 *
 * Turns the already-evaluated service declarations (imported by the thin
 * per-service script under bun/tsx) into the normalized context the
 * renderer consumes:
 *
 *   - `collectDocRoutes` / `sheetsFromNav` — declared census → DocRoute /
 *     DocSheet entries (delivery classified: host-static / archetype /
 *     remote).
 *   - `normalizeEntityContext` — evaluated `EntityRouteDecl`-shaped
 *     objects → `meta_by_entity` + `caps_by_entity` (permissions already
 *     resolved to strings by the service runtime — no enum parsing).
 *   - `scanRouterCaps` — BE router-file fallback when evaluated decls are
 *     not importable (regex scan + permissions.d.ts resolution).
 *   - `collectCensusOptions` — emits/callables normalized for
 *     `options_source` prose.
 *   - `assertWithinRoot` — hard repository isolation guard.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
  CallableDecl,
  EmitDecl,
  ModuleNavDeclaration,
} from "@primebrick/core";
import type { DocRoute, DocSheet, EntityCaps } from "./types.js";

// ── repo-root guard ─────────────────────────────────────────────────────

/**
 * Hard isolation gate — every filesystem path the engine touches MUST
 * resolve inside the service's repo root (the one sanctioned exception is
 * `fe_src_dir`, which the caller widens explicitly for the BE↔FE pair).
 * Throws on escape — enforcement, never a warning.
 */
export function assertWithinRoot(root: string, ...paths: string[]): void {
  const r = resolve(root) + sep;
  for (const p of paths) {
    const abs = resolve(p);
    if (!abs.startsWith(r) && abs !== resolve(root)) {
      throw new Error(`docs-gen: path escapes repository root — ${abs} (root: ${resolve(root)})`);
    }
  }
}

// ── declared census → doc routes ────────────────────────────────────────

/**
 * `nav.routes` → documentable route entries. Catch-all/bracket segments
 * are rejected BY CONSTRUCTION (they are not documentable pages — e.g.
 * `/docs/[...path]` never becomes `[...path].mdx`).
 */
export function collectDocRoutes(nav: ModuleNavDeclaration): DocRoute[] {
  const out: DocRoute[] = [];
  for (const r of nav.routes ?? []) {
    if (r.route.includes("[...") || r.route.includes("*")) continue;
    // normalize param segments once: `[uuid]` (FE file convention) →
    // `{uuid}` — the renderer works on a single notation
    const route = r.route.replace(/\[(\w+)\]/g, "{$1}");
    out.push({
      route,
      kind: r.kind,
      entity: r.entity,
      label_key: r.label_key,
      description_key: r.description_key,
      icon: r.icon,
      component_url: r.component_url,
      presentation: r.presentation,
      form: r.page_props?.form as DocRoute["form"],
      delivery: r.component_url ? "remote" : r.page_props?.form ? "archetype" : "host-static",
    });
  }
  return out;
}

/** `nav.sheets` → documentable sheet surfaces. */
export function sheetsFromNav(nav: ModuleNavDeclaration): DocSheet[] {
  return (nav.sheets ?? []).map((s) => ({
    key: s.key,
    label_key: s.label_key,
    component_url: s.component_url,
    default_options: s.default_options,
  }));
}

// ── evaluated entity decls → render context ─────────────────────────────

/** Minimum evaluated shape — matches `EntityRouteDecl`/`EntityRouterConfig`. */
export interface EvaluatedEntityDecl {
  entityName?: string;
  entity?: string;
  meta?: Record<string, unknown>;
  permissions?: Record<string, readonly string[]>;
  auditable?: boolean;
  duplicate?: false | boolean;
  guards?: Record<string, unknown>;
  /** Legacy alias — BE caps-scans may carry middleware-derived step-up. */
  stepUp?: Record<string, boolean>;
}

export interface EntityContext {
  /** entity → served meta (columns, table options, display, collaboration). */
  meta_by_entity: Record<string, Record<string, unknown>>;
  /** entity → capabilities (perms already resolved to strings). */
  caps_by_entity: Record<string, EntityCaps>;
}

/**
 * Evaluated `EntityRouteDecl[]` → normalized context. `guards` keys map to
 * step-up flags (the presence of an action guard means the op is guarded —
 * the renderer only narrates step-up, never the guard mechanism).
 */
export function normalizeEntityContext(decls: EvaluatedEntityDecl[]): EntityContext {
  const meta_by_entity: EntityContext["meta_by_entity"] = {};
  const caps_by_entity: EntityContext["caps_by_entity"] = {};
  for (const d of decls) {
    const entity = d.entityName ?? d.entity;
    if (!entity) continue;
    if (d.meta) meta_by_entity[entity] = d.meta;
    const stepUp: Record<string, boolean> = { ...(d.stepUp ?? {}) };
    for (const action of Object.keys(d.guards ?? {})) stepUp[action] = true;
    caps_by_entity[entity] = {
      perms: Object.fromEntries(
        Object.entries(d.permissions ?? {}).map(([k, v]) => [k, [...v]]),
      ),
      extraScans: [],
      duplicate: d.duplicate,
      stepUp,
      auditable: d.auditable,
    };
  }
  return { meta_by_entity, caps_by_entity };
}

// ── BE router-scan fallback (legacy behavior, moved into the engine) ────

export interface ScannedRoute {
  method: string;
  path: string;
  perms: string[];
  stepUp: boolean;
}

export interface RouterScanResult {
  caps_by_entity: Record<string, EntityCaps>;
  extraRoutes: ScannedRoute[];
}

/** Parse `@primebrick/sdk` permissions.d.ts → enum NAME → permission string. */
export function loadPermValues(dtsPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const dts = readFileSync(dtsPath, "utf8");
    for (const m of dts.matchAll(/readonly\s+(\w+)\s*:\s*"([^"]+)"/g)) out[m[1]] = m[2];
  } catch { /* absent — enum names fall through unresolved */ }
  return out;
}

function findRouterFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findRouterFiles(p));
    else if (e.name.endsWith(".router.ts")) out.push(p);
  }
  return out;
}

/**
 * BE variant — `makeEntityRouter` configs live inside controller files
 * that are not importable without boot. Regex scan over `*.router.ts`
 * resolves `entityName`, `permissions`, `duplicate`, `actionMiddlewares`
 * (→ stepUp) and `metaExtraScans` prefixes — same output as the legacy
 * ai/scripts scan, moved into the shared engine.
 */
export function scanRouterCaps(routerDir: string, permValues: Record<string, string>): RouterScanResult {
  const caps_by_entity: Record<string, EntityCaps> = {};
  const extraRoutes: ScannedRoute[] = [];
  for (const f of findRouterFiles(routerDir)) {
    const src = readFileSync(f, "utf8");
    for (const rm of src.matchAll(/\{\s*method:\s*"(\w+)",\s*path:\s*"([^"]+)",([\s\S]*?)\}/g)) {
      const perms = [...rm[3].matchAll(/Permission\.(\w+)/g)].map((x) => permValues[x[1]] ?? x[1]);
      extraRoutes.push({ method: rm[1].toUpperCase(), path: rm[2], perms, stepUp: /requireMfaStepUp/.test(rm[3]) });
    }
    for (const m of src.matchAll(/entityName:\s*"(\w+)"/g)) {
      const entity = m[1];
      const caps = caps_by_entity[entity] ??= { perms: {}, extraScans: [], duplicate: undefined, stepUp: {} };
      const permsM = src.slice(m.index).match(/permissions:\s*\{([\s\S]*?)\}/);
      if (permsM)
        for (const pm of permsM[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g))
          caps.perms[pm[1]] = [...pm[2].matchAll(/Permission\.(\w+)/g)].map((x) => permValues[x[1]] ?? x[1]);
      const dupM = src.slice(m.index).match(/duplicate:\s*(true|false)/);
      if (dupM) caps.duplicate = dupM[1] === "true";
      const amM = src.slice(m.index).match(/actionMiddlewares:\s*\{([\s\S]*?)\}/);
      if (amM)
        for (const am of amM[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g))
          caps.stepUp[am[1]] = /requireMfaStepUp/.test(am[2]);
      for (const sm of src.slice(m.index).matchAll(/prefix:\s*"([^"]+)"/g)) caps.extraScans.push(sm[1]);
    }
  }
  return { caps_by_entity, extraRoutes };
}

/** Map an extra-scanned route to a standard op / `custom:<name>` action. */
export function routeOp(r: ScannedRoute, prefixes: string[] = []): string | null {
  const p = r.path;
  if (/\/purge\b/.test(p)) return "purge.single";
  if (/\/restore\b/.test(p)) return "restore.single";
  if (/\/audit\b/.test(p)) return "read.audit";
  if (/\/export\b/.test(p)) return "export";
  if (/\/bulk-delete\b/.test(p)) return "delete.bulk";
  if (/\/bulk-restore\b/.test(p)) return "restore.bulk";
  if (/\/duplicate\b/.test(p)) return "duplicate.bulk";
  const last = p.split("/").pop() ?? "";
  if (r.method === "POST" && prefixes.includes(p)) return "create.single";
  if (r.method === "POST" && last !== ":uuid" && !/^:/.test(last)) return `custom:${last}`;
  if (r.method === "POST") return "create.single";
  if (r.method === "PUT" || r.method === "PATCH") return "update.single";
  if (r.method === "DELETE") return "delete.single";
  return null;
}

/** Resolve the extra-scanned routes an entity's caps prefix covers. */
export function scanRoutes(caps: EntityCaps | undefined, extraRoutes: ScannedRoute[]): ScannedRoute[] {
  return (caps?.extraScans ?? []).flatMap((pre) => extraRoutes.filter((r) => r.path.startsWith(pre)));
}

// ── census options (emits/callables → selectable subjects) ─────────────

export interface CensusOption {
  subject: string;
  label_key?: string;
  description_key?: string;
  /** Owning service code — labels resolve in ITS translation schema. */
  service?: string;
  kind?: string;
  permissions?: readonly string[];
  payload_schema?: Record<string, unknown>;
  entity?: { key: string; entity: string; table: string };
}

/**
 * Census-wide option vocabulary for `options_source` fields — every
 * module's declared `emits`/`callables`, normalized. `service` keeps the
 * owner so label/description keys resolve in the right translation schema
 * (the lexicon is the union of all service schemas).
 */
export function collectCensusOptions(
  sources: { service: string; emits?: EmitDecl[]; callables?: CallableDecl[] }[],
): { emits: CensusOption[]; callables: CensusOption[] } {
  const emits: CensusOption[] = [];
  const callables: CensusOption[] = [];
  for (const s of sources) {
    for (const e of s.emits ?? [])
      emits.push({ subject: e.subject, label_key: e.label_key, description_key: e.description_key, service: s.service, payload_schema: e.payload_schema, entity: e.entity });
    for (const c of s.callables ?? [])
      callables.push({ subject: c.subject, label_key: c.label_key, description_key: c.description_key, service: s.service, kind: c.kind, permissions: c.permissions, payload_schema: c.payload_schema });
  }
  return { emits, callables };
}

// ── ownership boundary ──────────────────────────────────────────────────

/**
 * Entities declared by OTHER services' registry nav — the ownership
 * boundary for the renderer's foreign-skip. Pass the service's own code;
 * every `endpoints.nav.routes[].entity` of every OTHER service lands in
 * the set.
 */
export function foreignEntitiesFromRegistry(
  registry: { code: string; endpoints?: Record<string, unknown> }[],
  ownCode: string,
): string[] {
  const out = new Set<string>();
  for (const r of registry) {
    if (r.code === ownCode) continue;
    const nav = (r.endpoints?.nav ?? {}) as { routes?: { entity?: string }[] };
    for (const route of nav.routes ?? []) if (route.entity) out.add(route.entity);
  }
  return [...out];
}

/**
 * Route paths claimed by OTHER services' registry nav — used by the
 * backend generator to subtract service-owned pages from the host-static
 * route universe (BE documents only what no module declared).
 */
export function claimedRoutesFromRegistry(
  registry: { code: string; endpoints?: Record<string, unknown> }[],
  ownCode: string,
): string[] {
  const out = new Set<string>();
  for (const r of registry) {
    if (r.code === ownCode) continue;
    const nav = (r.endpoints?.nav ?? {}) as { routes?: { route?: string }[] };
    for (const route of nav.routes ?? []) if (route.route) out.add(route.route);
  }
  return [...out];
}

// ── translation merge ───────────────────────────────────────────────────

/**
 * Merge translation scopes first-writer-wins — pass scopes ordered by
 * precedence (own schema first, then system/public/custom, then the
 * census-wide lexicon of all service schemas for option labels).
 */
export function mergeTranslationScopes(...dicts: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of dicts) for (const [k, v] of Object.entries(d)) out[k] ??= v;
  return out;
}
