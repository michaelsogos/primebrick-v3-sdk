/**
 * docs-gen — shared per-service wiring.
 *
 * The three historical generate-page-docs.ts scripts (be / ai / job-handler)
 * carried ~70% identical boilerplate: pg client + service_registry SELECT,
 * translation-dict merge, census options, idp lookup, remote/host fact
 * application, console report + _order.json reconcile. Those parts live
 * here ONCE — a service script now contributes only its real inputs:
 * declarations, service_code, access namespace, own schema, fe source mode.
 *
 * Dependency posture is unchanged: `pg`/`typescript`/`svelte` are resolved
 * by the calling service from ITS OWN node_modules (createRequire on the
 * service's package.json, svelte from the service's — or the sanctioned
 * BE↔FE pair root's — compiler). The engine never hardcodes a dependency.
 */
// Build-time doc tooling queries dynamic `<schema>.translations` across
// every registry schema: no entity DSL can express a runtime-interpolated
// schema/table; the queries read service_registry/config_entries, never
// entity rows. The sanctioned seam is declared in .devin/check-standards.json
// (raw-sql allowPaths) — never via inline suppression.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  claimedRoutesFromRegistry,
  collectCensusOptions,
  mergeTranslationScopes,
} from "./collect.js";
import {
  extractHostRouteSet,
  extractRemoteFacts,
  parseRemoteDispatch,
  routeFromHostFile,
  walkHostPages,
} from "./extract-svelte.js";
import { reconcileOrder } from "./order.js";
import type {
  DocRoute,
  DocSheet,
  RemoteDispatchMap,
  SvelteCompilerPort,
} from "./types.js";
import type { ExtractDeps } from "./extract-svelte.js";
import type { RenderReport } from "./render.js";

// ── dependency loading (service-local node_modules) ─────────────────────

export interface DocsCompilers {
  ts: typeof import("typescript");
  PgClient: new (cfg: { connectionString: string }) => DocsPgClient;
  svelte: SvelteCompilerPort;
}

export interface DocsPgClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/**
 * Resolve `typescript` + `pg` from the service's own node_modules and the
 * svelte compiler from `svelte_root` (defaults to the service root — the BE
 * passes the sanctioned fe-v3 root so the host-page AST dialect matches).
 */
export async function loadDocsCompilers(
  service_root: string,
  svelte_root?: string,
): Promise<DocsCompilers> {
  const req = createRequire(join(service_root, "package.json"));
  const ts = req("typescript") as typeof import("typescript");
  const { Client } = req("pg") as {
    Client: new (cfg: { connectionString: string }) => DocsPgClient;
  };
  const svelte = (
    await import(
      pathToFileURL(
        join(svelte_root ?? service_root, "node_modules/svelte/compiler/index.js"),
      ).href
    )
  ).default as SvelteCompilerPort;
  return { ts, PgClient: Client, svelte };
}

// ── DB preamble: registry + translations + census + idp ─────────────────

export interface RegistryRow {
  code: string;
  schemas?: string[];
  endpoints?: Record<string, unknown>;
}

export interface DocsDbContext {
  registry: RegistryRow[];
  translations: Record<string, string>;
  census_options: ReturnType<typeof collectCensusOptions>;
  idp_name?: string;
}

/**
 * The identical DB preamble every script carried: registry rows, the
 * en-GB translation dicts (own schemas first, then every other service
 * schema as option-label lexicon), census emits/callables and the IdP
 * display name. Caller owns connect()/end().
 */
export async function loadDocsDbContext(
  pg: DocsPgClient,
  own_schemas: string[],
): Promise<DocsDbContext> {
  const { rows: registry } = await pg.query<RegistryRow>(
    `SELECT code, schemas, endpoints FROM service_registry WHERE deleted_at IS NULL`,
  );
  const lexiconSchemas = [...new Set(registry.flatMap((r) => r.schemas ?? []))].filter(
    (s) => !own_schemas.includes(s),
  );
  const dicts: Record<string, string>[] = [];
  for (const s of [...own_schemas, ...lexiconSchemas]) {
    try {
      const r = await pg.query<{ key: string; value: string }>(
        `SELECT key, value FROM ${s}.translations WHERE language='en-GB'`,
      );
      dicts.push(Object.fromEntries(r.rows.map((row) => [row.key, row.value])));
    } catch {
      /* schema without translations */
    }
  }
  let idp_name: string | undefined;
  try {
    const {
      rows: [idp],
    } = await pg.query<{ value: string }>(
      `SELECT value FROM public.config_entries WHERE key='idp_type' LIMIT 1`,
    );
    idp_name = idp?.value ? idp.value.replace(/\b\w/g, (c: string) => c.toUpperCase()) : undefined;
  } catch {
    /* absent */
  }
  return {
    registry,
    translations: mergeTranslationScopes(...dicts),
    census_options: collectCensusOptions(
      registry.map((r) => ({
        service: r.code,
        emits: (r.endpoints?.events as { emits?: [] } | undefined)?.emits ?? [],
        callables:
          (r.endpoints?.callables as { callables?: [] } | undefined)?.callables ?? [],
      })),
    ),
    idp_name,
  };
}

// ── remote fe facts (module-owned chunks) ───────────────────────────────

export interface RemoteDocsFe {
  mode: "remote";
  /** `fe/src` of the service (assertWithinRoot target). */
  src_dir: string;
  /**
   * Chunk entries to parse, merged in order. `pages`/`sheets` select which
   * half of the dispatch map each file contributes (ai splits pages.ts /
   * index.ts; single-entry chunks leave both on). Default:
   * `[{ file: "index.ts", pages: true, sheets: true }]`.
   */
  dispatch?: { file: string; pages?: boolean; sheets?: boolean }[];
  assertWithinRoot: (root: string, ...paths: string[]) => void;
}

/**
 * Parse the remote chunk dispatch maps and attach `extractRemoteFacts` to
 * each route/sheet — plus `opened_by` (route facts naming the sheet via
 * `openSheet('<key>')`). Mutates the passed collections (the scripts'
 * historical behavior).
 */
export function applyRemoteFacts(
  fe: RemoteDocsFe,
  routes: DocRoute[],
  sheets: DocSheet[],
  deps: ExtractDeps,
): void {
  const dispatch: RemoteDispatchMap = { pages: {}, sheets: {} };
  for (const entry of fe.dispatch ?? [{ file: "index.ts", pages: true, sheets: true }]) {
    const d = parseRemoteDispatch(
      readFileSync(join(fe.src_dir, entry.file), "utf8"),
      {
        ...(entry.pages !== false
          ? { component_url_routes: routes.filter((r) => r.component_url).map((r) => r.route) }
          : {}),
        ...(entry.sheets !== false ? { sheet_keys: sheets.map((s) => s.key) } : {}),
      },
      deps.ts,
    );
    if (entry.pages !== false) Object.assign(dispatch.pages, d.pages);
    if (entry.sheets !== false) Object.assign(dispatch.sheets, d.sheets);
  }
  for (const r of routes) {
    const file = dispatch.pages[r.route];
    if (!file) continue;
    fe.assertWithinRoot(fe.src_dir, join(fe.src_dir, file));
    r.facts = extractRemoteFacts(readFileSync(join(fe.src_dir, file), "utf8"), r.route, deps);
  }
  for (const s of sheets) {
    const file = dispatch.sheets[s.key];
    if (!file) continue;
    fe.assertWithinRoot(fe.src_dir, join(fe.src_dir, file));
    s.facts = extractRemoteFacts(
      readFileSync(join(fe.src_dir, file), "utf8"),
      `sheet:${s.key}`,
      deps,
    );
  }
  for (const s of sheets) {
    s.opened_by = routes
      .filter((r) => r.facts?.sheetOpenings?.includes(s.key))
      .map((r) => r.route);
  }
}

// ── host fe facts (BE↔FE sanctioned pair) ───────────────────────────────

export interface HostDocsFe {
  mode: "host";
  /** FE routes root — `fe-v3/src/routes/(app)`. */
  routes_root: string;
  /** Extra exclusion beyond the defaults (catch-alls, `/`, `/dev/*`). */
  exclude?: (route: string) => boolean;
}

/**
 * BE variant: walk every host `+page.svelte`, subtract routes claimed by
 * module services (registry) or already declared, extract facts on the
 * surviving set, and append the unclaimed statics as `kind:"page"` routes.
 * Returns the final route list (routeMap mutated in place — declared
 * routes gain `.facts`).
 */
export function applyHostFacts(
  fe: HostDocsFe,
  routes: DocRoute[],
  registry: RegistryRow[],
  service_code: string,
  deps: ExtractDeps,
): DocRoute[] {
  const routeMap = new Map(routes.map((r) => [r.route, r]));
  const claimed = new Set(claimedRoutesFromRegistry(registry, service_code));
  const allHostRoutes = walkHostPages(fe.routes_root).map((f) =>
    routeFromHostFile(f, fe.routes_root),
  );
  const unclaimed = allHostRoutes.filter(
    (r) =>
      !routeMap.has(r) &&
      !claimed.has(r) &&
      !r.includes("[...") &&
      !r.includes("{...") &&
      r !== "/" &&
      !r.startsWith("/dev/") &&
      !(fe.exclude?.(r) ?? false),
  );
  const hostFacts = extractHostRouteSet(
    fe.routes_root,
    allHostRoutes.filter((r) => routeMap.has(r) || unclaimed.includes(r)),
    deps,
  );
  for (const [route, doc] of routeMap) if (hostFacts[route]) doc.facts = hostFacts[route];
  for (const route of unclaimed)
    routeMap.set(route, {
      route,
      kind: "page",
      facts: hostFacts[route],
      delivery: "host-static",
    });
  return [...routeMap.values()];
}

// ── report + order reconcile (identical console block) ──────────────────

/** Print the generation report and reconcile `_order.json` on disk. */
export function printDocsReport(report: RenderReport, out_dir: string): void {
  console.log(`generated ${report.emitted.length} page(s) → docs/user-guide/generated`);
  for (const f of report.emitted) console.log(`  + ${f}`);
  if (report.skipped.length) {
    console.warn(
      `coverage: ${report.skipped.length} declared route(s) produced no document:`,
    );
    for (const s of report.skipped) console.warn(`  - ${s.route} (${s.reason})`);
  }
  if (report.ghosts_deleted.length) {
    console.log(`ghosts deleted: ${report.ghosts_deleted.join(", ")}`);
  }
  const ord = reconcileOrder(out_dir);
  if (ord.added.length || ord.dropped.length) {
    console.log(`_order.json: +${ord.added.length} -${ord.dropped.length}`);
  }
}
