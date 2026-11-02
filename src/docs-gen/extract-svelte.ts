/**
 * docs-gen — deterministic AST extraction of Svelte sources.
 *
 * Two variants over the same machinery:
 *
 *   - `extractHostFacts` — host `+page.svelte` files (BE-owned surfaces in
 *     fe-v3). Callees: `apiFetch`, `apiFetchWithTimeout`, `goto`,
 *     `window.open`, `$t('…')`.
 *   - `extractRemoteFacts` — service-remote module sources
 *     (`<svc>/fe/src/*.svelte`). Callees: `ctx.api(…)`, `ctx.i18n.t(…)`
 *     (usually aliased to `t(…)`), `openSheet('…')`, `ctx.sheet.props.*`,
 *     `notifyParentAndClose`.
 *
 * Both are pure functions over source text — the Svelte compiler and the
 * TypeScript module are injected so the engine carries no heavy deps and
 * runs under bun, tsx or node wherever the caller lives.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type * as TsModule from "typescript";
import type {
  ExtractedField,
  RemoteDispatchMap,
  SvelteCompilerPort,
  SveltePageFacts,
} from "./types.js";

export interface ExtractDeps {
  svelte: SvelteCompilerPort;
  ts: typeof TsModule;
}

// ── script facts ────────────────────────────────────────────────────────

interface ScriptFacts {
  fields: Record<string, ExtractedField>;
  endpoints: { method: string; path: string }[];
  navigations: { kind: "same-tab" | "new-tab"; target: string }[];
  composables: string[];
  schemaVar: string | null;
  superRefines: number;
  customActions: string[];
  constUrls: Record<string, string>;
  sheetProps: string[];
  sheetOpenings: string[];
  entityDecl?: SveltePageFacts["entityDecl"];
  remoteMount?: boolean;
}

function zodFieldInfo(initExpr: TsModule.Expression, sf: TsModule.SourceFile, ts: typeof TsModule) {
  // unwrap chains: z.string().min(1).default('x') → { type, required, constraints }
  const info: ExtractedField = { type: "unknown", required: true, constraints: [], default: undefined };
  let node: TsModule.Expression = initExpr;
  while (node && ts.isCallExpression(node)) {
    const exprText = node.expression.getText(sf);
    if (/^z\.\w+$/.test(exprText)) { info.type = exprText + "()"; break; }
    const m = exprText.match(/\.(\w+)$/);
    const method = m?.[1];
    if (method === "optional" || method === "or" || method === "nullable") info.required = false;
    if (method === "default") { info.required = false; info.default = node.arguments[0]?.getText(sf); }
    if (method && ["min", "max", "email", "url", "regex", "refine", "superRefine"].includes(method))
      info.constraints.push(method + "(" + node.arguments.map((a) => a.getText(sf)).join(", ").slice(0, 60) + ")");
    node = ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
      ? node.expression.expression : node.expression;
  }
  if (node && ts.isIdentifier(node)) info.type = node.getText(sf); // helper wrapper e.g. idpNameSchema(...)
  return info;
}

/** state variables that are never form fields (entity holders, generic state). */
const STATE_STOP = new Set([
  "role", "user", "org", "item", "entity", "record", "data", "form", "formdata",
  "state", "value", "loading", "saving", "deleting", "error", "message", "result",
  "response", "open", "mode", "errors", "orgs", "orgsloading", "meta", "rows",
  "search", "appliedsearch", "page", "pagesize", "total", "visiblekeys",
  "selectedkeys", "filtersopen", "viewmode",
]);

function extractScriptFacts(scriptText: string, variant: "host" | "remote", ts: typeof TsModule): ScriptFacts {
  const sf = ts.createSourceFile("page.ts", scriptText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const facts: ScriptFacts = {
    fields: {}, endpoints: [], navigations: [], composables: [], schemaVar: null,
    superRefines: 0, customActions: [], constUrls: {}, sheetProps: [], sheetOpenings: [],
  };
  const visit = (n: TsModule.Node): void => {
    // const url = '/route/...' — resolve window.open/goto variable targets
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer) || ts.isTemplateExpression(n.initializer))) {
      const v = n.initializer.getText(sf).replace(/[`'"]/g, "");
      if (v.startsWith("/")) facts.constUrls[n.name.text] = v;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      // ── outbound API calls ──
      const isApiCall = variant === "host"
        ? callee === "apiFetch" || callee === "apiFetchWithTimeout"
        : callee === "ctx.api" || callee === "ctx.api_fetch" || callee === "apiFetch" || callee === "apiFetchWithTimeout";
      if (isApiCall) {
        const url = n.arguments[0]?.getText(sf)?.replace(/['"`]/g, "")
          .replace(/\$\{[^}]*\}/g, "{param}")
          .replace(/'\s*\+\s*[\w.\[\]'"]+$/, "{param}");
        const opts = n.arguments[1]?.getText(sf) || "";
        const method = opts.match(/method:\s*['"](\w+)/)?.[1] || "GET";
        if (url?.startsWith("/")) facts.endpoints.push({ method, path: url.split("?")[0] });
      }
      // persistence via composable methods: roleMappings.create(...) / .update(...)
      const cm = callee.match(/^(\w+)\.(create|update|save|remove|delete|purge)$/);
      if (cm && !["next", "prev", "this", "selected_permissions", "errors"].includes(cm[1])) {
        facts.endpoints.push({ method: cm[2].toUpperCase(), path: `(via ${callee})` });
      }
      // ── navigation ──
      if (callee === "goto" || callee === "window.open" || callee === "ctx.nav.goto") {
        let arg = n.arguments[0];
        // typed-routes idiom: goto(resolve('/path')) — the literal lives
        // inside the resolve() call
        if (arg && ts.isCallExpression(arg) && arg.expression.getText(sf) === "resolve")
          arg = arg.arguments[0];
        let target = arg?.getText(sf)?.slice(0, 120);
        const idm = target?.match(/^['"`]?(\w+)['"`]?$/);
        if (idm && facts.constUrls[idm[1]]) target = facts.constUrls[idm[1]];
        if (target && (target.includes("${") || /^['"`]/.test(target))) target = target.replace(/[`'"]/g, "");
        if (target) facts.navigations.push({ kind: callee === "window.open" ? "new-tab" : "same-tab", target });
      }
      // remote sheet openers: openSheet('mod.key') / ctx.openSheet('mod.key')
      if (callee === "openSheet" || callee === "ctx.open_sheet" || callee === "open_sheet") {
        const key = n.arguments[0]?.getText(sf)?.replace(/['"`]/g, "");
        if (key) facts.sheetOpenings.push(key);
      }
      if (callee.match(/^use[A-Z]/)) facts.composables.push(callee);
      if (callee.endsWith("superRefine")) facts.superRefines++;
      // plain-state form fields: let idp_role = $state('') / is_admin = $state(false)
      if (callee === "$state" && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
        const fname = n.parent.name.getText(sf);
        const norm = fname.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!STATE_STOP.has(norm) && !facts.fields[fname]) {
          const init = n.arguments[0];
          const t = init ? (ts.isStringLiteral(init) ? "string"
            : init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword ? "boolean"
            : ts.isNumericLiteral(init) ? "number" : "unknown") : "unknown";
          facts.fields[fname] = { type: t, required: !t.match(/boolean|number/), constraints: [], default: init?.getText(sf), fromState: true };
        }
      }
      if (callee === "z.object") {
        const arg = n.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p)) {
              facts.fields[p.name.getText(sf)] = zodFieldInfo(p.initializer, sf, ts);
            }
          }
        }
      }
    }
    // remote sheet props: ctx.sheet.props.<name> or ['name'] reads
    if (variant === "remote" && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
      const text = n.getText(sf);
      const m = text.match(/^ctx\.sheet\.props\.(\w+)$/)
        ?? text.match(/^ctx\.sheet\.props\[['"`](\w+)['"`]\]$/)
        ?? text.match(/^ctx\.props\.(\w+)$/)
        ?? text.match(/^ctx\.props\[['"`](\w+)['"`]\]$/);
      if (m && !facts.sheetProps.includes(m[1])) facts.sheetProps.push(m[1]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return facts;
}

// ── template facts ──────────────────────────────────────────────────────

const WIDGET_TAGS = [
  "FormField", "Checkbox", "Button", "ComboSelect", "AsyncValidatedInput",
  "TextInput", "PasswordInput", "DeleteDialog", "EntityListTable",
  "EntityTablePage", "EntityFormPage", "RemotePageMount",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkTemplate(node: any, out: { widgets: SveltePageFacts["widgets"] }): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walkTemplate(c, out); return; }
  if (node.type === "Component" || node.type === "RegularElement" || node.type === "InlineComponent") {
    const tag = node.name;
    if (WIDGET_TAGS.includes(tag)) {
      const attrs: Record<string, unknown> = {};
      for (const a of node.attributes ?? []) {
        if (a.type === "Attribute") {
          const v = a.value;
          attrs[a.name] = Array.isArray(v) ? (v[0]?.data ?? v[0]?.expression?.name ?? v[0]?.expression?.value ?? true) : (v?.name ?? true);
        } else if (a.type === "BindDirective") attrs["bind:" + a.name] = a.expression?.name;
      }
      out.widgets.push({ tag, attrs });
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") walkTemplate(v, out);
  }
}

function extractTemplateFacts(ast: unknown, raw: string, variant: "host" | "remote") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: { widgets: SveltePageFacts["widgets"]; i18nKeys: string[] } = { widgets: [], i18nKeys: [] };
  // cheap regex pass for translation keys — reliable and readable.
  // host pages use $t('…'); remote sources alias ctx.i18n.t to t(…).
  const re = variant === "host" ? /\$t\('([^']+)'/g : /(?:ctx\.i18n\.t|\bt)\('([^']+)'/g;
  for (const m of raw.matchAll(re)) out.i18nKeys.push(m[1]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = (ast as any).fragment ?? (ast as any).html;
  walkTemplate(root, out);
  return out;
}

// ── public API ──────────────────────────────────────────────────────────

function extractFacts(raw: string, route: string, variant: "host" | "remote", deps: ExtractDeps): SveltePageFacts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ast = deps.svelte.parse(raw, { modern: true }) as any;
  const scriptText = ast.instance ? raw.slice(ast.instance.content.start, ast.instance.content.end) : "";
  const sfacts = extractScriptFacts(scriptText, variant, deps.ts);
  const tfacts = extractTemplateFacts(ast, raw, variant);
  // customActionHandlers lives in template markup: {{ change_password: fn, ... }}
  for (const m of raw.matchAll(/customActionHandlers=\{\{([\s\S]*?)\}\}/g))
    for (const k of m[1].matchAll(/^\s*(\w+)\s*:/gm)) sfacts.customActions.push(k[1]);
  // link-style CTAs: <Button href="/route"> / <a href="/route"> are navigations too
  for (const w of tfacts.widgets)
    if (typeof w.attrs.href === "string" && w.attrs.href.startsWith("/"))
      sfacts.navigations.push({ kind: "same-tab", target: w.attrs.href });
  // dedupe navigations
  const seen = new Set<string>();
  sfacts.navigations = sfacts.navigations.filter((n) => seen.has(n.target) ? false : (seen.add(n.target), true));
  // $state-derived fields are kept only if bound in the template
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const boundIds = new Set<string>();
  for (const w of tfacts.widgets)
    for (const [k, v] of Object.entries(w.attrs))
      if (/^(id|bind:value|bind:checked|name|data-testid)$/.test(k)) {
        boundIds.add(norm(v));
        for (const piece of String(v).split(/[^a-zA-Z0-9_]/)) if (piece.length > 2) boundIds.add(norm(piece));
      }
  // when a zod schema exists it is the source of truth — drop $state guesses;
  // otherwise keep only names referenced in the markup
  const hasZod = Object.values(sfacts.fields).some((f) => !f.fromState);
  const markup = raw.slice(ast.instance ? ast.instance.content.end : 0);
  for (const [fname, f] of Object.entries(sfacts.fields)) {
    if (!f.fromState) continue;
    if (STATE_STOP.has(norm(fname))) { delete sfacts.fields[fname]; continue; }
    const bound = boundIds.has(norm(fname)) ||
      [...boundIds].some((b) => b.endsWith(norm(fname)) || (norm(fname).length > 3 && norm(fname).endsWith(b)));
    const boundInMarkup = new RegExp(`bind:(value|checked)=\\{?${fname}\\b`).test(markup)
      || new RegExp(`\\b${fname}\\.(has|add|delete|size|toggle|values)\\b`).test(markup)
      || new RegExp(`\\bid=['"]${fname}['"]`).test(markup);
    if (hasZod || !(bound || boundInMarkup)) delete sfacts.fields[fname];
  }
  // ── shell-page contract — EntityTablePage/EntityFormPage declare their
  // entity via `entity` or `basePath` props, never via apiFetch calls.
  const shell = tfacts.widgets.find((w) => w.tag === "EntityTablePage" || w.tag === "EntityFormPage");
  if (shell) {
    const bp = shell.attrs.basePath;
    let entity = shell.attrs.entity as string | undefined;
    if (!entity && typeof bp === "string") {
      const m = bp.match(/entities\/(\w+)/) ?? bp.match(/^\/([\w-]+)$/);
      if (m) entity = m[1];
    }
    if (!entity) {
      const m = raw.match(/entityApiBase\(['"](\w+)['"]\)/);
      if (m) entity = m[1];
    }
    sfacts.entityDecl = {
      component: shell.tag, entity,
      basePath: typeof bp === "string" ? bp : undefined,
      createAction: "onCreateAction" in shell.attrs || "createPath" in shell.attrs,
      editAction: "onEditAction" in shell.attrs || "editPath" in shell.attrs,
      navStrategy: typeof shell.attrs.navStrategy === "string" ? shell.attrs.navStrategy : undefined,
    };
  }
  if (tfacts.widgets.some((w) => w.tag === "RemotePageMount")) sfacts.remoteMount = true;
  return {
    route,
    fields: sfacts.fields,
    endpoints: sfacts.endpoints,
    navigations: sfacts.navigations,
    composables: [...new Set(sfacts.composables)],
    schemaVar: sfacts.schemaVar,
    superRefines: sfacts.superRefines,
    customActions: sfacts.customActions,
    constUrls: sfacts.constUrls,
    widgets: tfacts.widgets,
    i18nKeys: [...new Set(tfacts.i18nKeys)],
    entityDecl: sfacts.entityDecl,
    remoteMount: sfacts.remoteMount,
    sheetProps: [...new Set(sfacts.sheetProps)],
    sheetOpenings: [...new Set(sfacts.sheetOpenings)],
  };
}

/** Extract facts from one host `+page.svelte` source. */
export function extractHostFacts(raw: string, route: string, deps: ExtractDeps): SveltePageFacts {
  return extractFacts(raw, route, "host", deps);
}

/** Extract facts from one remote module source (`<svc>/fe/src/*.svelte`). */
export function extractRemoteFacts(raw: string, route: string, deps: ExtractDeps): SveltePageFacts {
  return extractFacts(raw, route, "remote", deps);
}

/** Walk a host routes directory for `+page.svelte` files. */
export function walkHostPages(routesDir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(routesDir, { withFileTypes: true })) {
    const p = join(routesDir, e.name);
    if (e.isDirectory()) out.push(...walkHostPages(p));
    else if (e.name === "+page.svelte") out.push(p);
  }
  return out;
}

/** Derive the route path from a host `+page.svelte` file path. */
export function routeFromHostFile(file: string, routesDir: string): string {
  const rel = file.replace(/\\/g, "/").split(routesDir.replace(/\\/g, "/") + "/")[1]
    ?.replace(/\/?\+page\.svelte$/, "") ?? "";
  return ("/" + rel).replace(/\[(\w+)\]/g, "{$1}");
}

/**
 * Extract host-page facts for a set of routes. `routesDir` is the FE app
 * routes root (`src/routes/(app)`); each route maps to
 * `<routesDir>/<route>/+page.svelte`.
 */
export function extractHostRouteSet(
  routesDir: string,
  routes: string[],
  deps: ExtractDeps,
): Record<string, SveltePageFacts> {
  const out: Record<string, SveltePageFacts> = {};
  for (const file of walkHostPages(routesDir)) {
    const route = routeFromHostFile(file, routesDir);
    if (!routes.includes(route)) continue;
    out[route] = extractHostFacts(readFileSync(file, "utf-8"), route, deps);
  }
  return out;
}

/**
 * Parse a remote chunk entry (`fe/src/index.ts` / `pages.ts`) and resolve
 * the route/sheet-key → component-file dispatch map.
 *
 * Two dispatch shapes are supported:
 *   - Record literals: `const PAGES = { '/route': Component }` (pages,
 *     keys start with `/`) and `const PANELS = { 'mod.key': Component }`
 *     (sheets, keys match `<module>.<name>`).
 *   - Fixed mounts: `mountPage`/`mountSheet` bodies that mount ONE
 *     component unconditionally — the component is assigned to every
 *     `component_url` route / declared sheet key the caller passes in.
 */
export function parseRemoteDispatch(
  entrySource: string,
  opts: { component_url_routes?: string[]; sheet_keys?: string[] },
  ts: typeof TsModule,
): RemoteDispatchMap {
  const sf = ts.createSourceFile("index.ts", entrySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importMap = new Map<string, string>();
  const pages: Record<string, string> = {};
  const sheets: Record<string, string> = {};

  // import Identifier from './File.svelte'
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.name && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (spec.endsWith(".svelte")) importMap.set(st.importClause.name.text, spec.replace(/^\.\//, ""));
    }
  }

  const assignRecord = (obj: TsModule.ObjectLiteralExpression): void => {
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = p.name.getText(sf).replace(/['"]/g, "");
      if (!ts.isIdentifier(p.initializer)) continue;
      const file = importMap.get(p.initializer.text);
      if (!file) continue;
      if (key.startsWith("/")) pages[key] = file;
      else if (/^\w+\.\w+$/.test(key)) sheets[key] = file;
    }
  };

  const visit = (n: TsModule.Node): void => {
    // const PAGES: Record<...> = { '/route': Component }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      assignRecord(n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // fixed-mount fallback: `mountPage`/`mountSheet` referencing one
  // imported component — assign it to the declared routes/sheet keys.
  const mountedComponents = (fnName: string): string[] => {
    const files: string[] = [];
    const w = (n: TsModule.Node): void => {
      if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name?.getText(sf) === fnName) {
        const inner = (m: TsModule.Node): void => {
          if (ts.isIdentifier(m)) {
            const f = importMap.get(m.text);
            if (f && !files.includes(f)) files.push(f);
          }
          ts.forEachChild(m, inner);
        };
        inner(n);
      }
      ts.forEachChild(n, w);
    };
    w(sf);
    return files;
  };
  if (!Object.keys(pages).length) {
    const mounted = mountedComponents("mountPage");
    for (const r of opts.component_url_routes ?? []) {
      if (mounted.length === 1) pages[r] = mounted[0];
    }
  }
  if (!Object.keys(sheets).length) {
    const mounted = mountedComponents("mountSheet");
    for (const k of opts.sheet_keys ?? []) {
      if (mounted.length === 1) sheets[k] = mounted[0];
    }
  }
  return { pages, sheets };
}
