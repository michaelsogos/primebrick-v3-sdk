/**
 * docs-gen emit — the service documents itself from its own boot
 * declaration.
 *
 * `emitServiceDocs` is the single entry both consumers call:
 *   - `createMicroservice` normal boot — re-emits the pack when the
 *     generation inputs changed since the last emit (manifest missing or
 *     `src/`/`fe/src`/`docs` newer than `dist/docs-pack/manifest.json`),
 *     so `docs_pack` capability is always backed by a fresh pack in dev.
 *   - `<svc> --emit-docs` — unconditional emit, then the caller exits
 *     (this is every service's `generate:docs` script — one identical
 *     line, zero per-service wiring).
 *
 * Inputs are the literal boot options (nav, the makeServiceRoutes
 * handler's `.entityDecls` + `.spec`), never a parallel docs config:
 * adding an entity or route to the service adds it to the docs by
 * construction. The only external input is the platform DB (registry,
 * translations, IdP name) via `loadDocsDbContext` — a service cannot
 * document itself correctly in isolation from the platform it serves.
 *
 * `--check` mode diffs a fresh emit against the committed `generated/`
 * without writing it — the release-close freshness gate.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ModuleNavDeclaration } from "@primebrick/core";
import { buildDocsPack } from "../docs-pack/build-docs-pack.js";
import type { EntityRouteDecl } from "../http/service-routes.js";
import {
  assertWithinRoot,
  collectDocRoutes,
  foreignEntitiesFromRegistry,
  normalizeEntityContext,
  sheetsFromNav,
  type EvaluatedEntityDecl,
} from "./collect.js";
import type { ExtractDeps } from "./extract-svelte.js";
import { reconcileOrder } from "./order.js";
import { generatePageDocs } from "./render.js";
import {
  applyRemoteFacts,
  loadDocsCompilers,
  loadDocsDbContext,
  printDocsReport,
} from "./service-docs.js";

export interface EmitServiceDocsInput {
  /** Service root (process.cwd() at boot). */
  service_root: string;
  /** Resolved service code — `resolveServiceCode` output. */
  service_code: string;
  /** Module nav declaration — `options.nav`; absent → no page-docs (webhook). */
  nav?: ModuleNavDeclaration;
  /** `routeHandler.entityDecls` (makeServiceRoutes brand). */
  entity_decls?: EntityRouteDecl[];
  /** `routeHandler.spec` (makeServiceRoutes brand) → openapi.json. */
  spec?: Record<string, unknown>;
  /** Own DB schemas (dbEnv.schemas — translations read own-first). */
  own_schemas: string[];
  /**
   * Extra high-priority translation schemas merged between `own_schemas`
   * and the registry lexicon — the platform namespaces whose labels win
   * over arbitrary service dicts (first-writer-wins). Default:
   * `["system", "public", "custom"]` — the historical script convention.
   */
  lexicon_schemas?: string[];
  /** Pack output dir — default `<root>/dist/docs-pack`. */
  pack_dir?: string;
  /**
   * Emit page-docs from sources (`fe/src` exists → remote facts).
   * Default: auto — pages emit iff nav && fe/src are present; otherwise
   * the pack assembles the already-committed docs verbatim (prod images
   * ship no `src/`/`fe/` — re-emitting would lose remote facts).
   */
  emit_pages?: boolean;
  /** Emit into a temp dir and diff against committed generated/ — no writes. */
  check?: boolean;
  /** Print the console report (default true). */
  report?: boolean;
}

export interface EmitServiceDocsResult {
  pages_emitted: number;
  pages_skipped: { route: string; reason: string }[];
  pack_files: number;
  /** `--check`: committed files that differ from a fresh emit. */
  drift: string[];
}

function newestMtime(dirs: string[]): number {
  let max = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          max = Math.max(max, statSync(full).mtimeMs);
        } catch { /* transient */ }
      }
    }
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir);
  return max;
}

/** Boot-time staleness: emit iff the pack is missing or generation inputs
 *  (sources, fe sources, authored docs) changed after it. Without any
 *  sources (deployed image) the built pack stands — never re-emit. */
export function docsPackStale(service_root: string, pack_dir: string): boolean {
  const manifest = join(pack_dir, "manifest.json");
  if (!existsSync(manifest)) return true;
  if (!existsSync(join(service_root, "src"))) return false;
  const newest = newestMtime([
    join(service_root, "src"),
    join(service_root, "fe", "src"),
    join(service_root, "docs", "user-guide"),
  ]);
  return newest > statSync(manifest).mtimeMs;
}

/** Every `fe/src/*.ts` is a potential dispatch entry — the vite `lib.entry`
 *  map duplicates the same information, the files themselves are the
 *  source. parseRemoteDispatch returns empty maps on non-dispatch files. */
function discoverFeDispatch(fe_src: string): { file: string; pages?: boolean; sheets?: boolean }[] {
  return readdirSync(fe_src)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ file, pages: true, sheets: true }));
}

function listMdx(dir: string, base = dir): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, listMdx(full, base));
    else if (e.name.endsWith(".mdx")) out[relative(base, full).split(sep).join("/")] = readFileSync(full, "utf-8");
  }
  return out;
}

export async function emitServiceDocs(input: EmitServiceDocsInput): Promise<EmitServiceDocsResult> {
  const {
    service_root,
    service_code,
    nav,
    entity_decls,
    spec,
    own_schemas,
    lexicon_schemas = ["system", "public", "custom"],
    emit_pages,
    check,
    report = true,
  } = input;
  const userGuideDir = join(service_root, "docs", "user-guide");
  const generatedDir = join(userGuideDir, "generated");
  const packDir = input.pack_dir ?? join(service_root, "dist", "docs-pack");
  const feSrc = join(service_root, "fe", "src");
  const hasFe = existsSync(feSrc);
  const wantPages = emit_pages ?? (nav !== undefined && hasFe);

  const result: EmitServiceDocsResult = { pages_emitted: 0, pages_skipped: [], pack_files: 0, drift: [] };

  // check mode emits into a temp copy inside dist/ (gitignored, and inside
  // the assertWithinRoot boundary) — the committed tree is never written
  const workRoot = check ? mkdtempSync(join(service_root, "dist", "docs-check-")) : service_root;
  const emitDir = check ? join(workRoot, "generated") : generatedDir;

  if (wantPages && nav) {
    assertWithinRoot(service_root, emitDir, feSrc);
    const { ts, PgClient, svelte } = await loadDocsCompilers(service_root);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("emitServiceDocs: DATABASE_URL is not set");
    const pg = new PgClient({ connectionString: databaseUrl });
    await pg.connect();
    const db = await loadDocsDbContext(
      pg,
      [...new Set([...own_schemas, ...lexicon_schemas])],
    );
    await pg.end();

    const routes = collectDocRoutes(nav);
    const sheets = sheetsFromNav(nav);
    if (hasFe) {
      applyRemoteFacts(
        { mode: "remote", src_dir: feSrc, dispatch: discoverFeDispatch(feSrc), assertWithinRoot },
        routes,
        sheets,
        // the service's own typescript resolves a different package version
        // than the SDK's type view — same runtime object, documented seam
        { svelte, ts: ts as unknown as ExtractDeps["ts"] },
      );
    }
    // EvaluatedEntityDecl is the documented minimal shape of
    // EntityRouteDecl — same object, narrower interface
    const { meta_by_entity, caps_by_entity } = normalizeEntityContext(
      (entity_decls ?? []) as EvaluatedEntityDecl[],
    );
    if (check) mkdirSync(emitDir, { recursive: true });
    const rep = generatePageDocs({
      service_code,
      routes,
      sheets,
      meta_by_entity,
      caps_by_entity,
      translations: db.translations,
      census_options: db.census_options,
      foreign_entities: foreignEntitiesFromRegistry(db.registry, service_code),
      idp_name: db.idp_name,
      access_namespace: nav.access,
      out_dir: emitDir,
    });
    result.pages_emitted = rep.emitted.length;
    result.pages_skipped = rep.skipped;
    if (report && !check) printDocsReport(rep, emitDir);
  }

  if (check) {
    const fresh = listMdx(emitDir);
    const committed = listMdx(generatedDir);
    for (const name of new Set([...Object.keys(fresh), ...Object.keys(committed)])) {
      if (fresh[name] === undefined) result.drift.push(`${name}: committed file has no fresh emit`);
      else if (committed[name] === undefined) result.drift.push(`${name}: not committed`);
      // line-ending normalization — git autocrlf makes worktree CRLF while
      // the emit writes LF; that is a checkout detail, not doc drift
      else if (fresh[name].replace(/\r\n/g, "\n") !== committed[name].replace(/\r\n/g, "\n"))
        result.drift.push(`${name}: content differs`);
    }
    rmSync(workRoot, { recursive: true, force: true });
    if (report) {
      console.log(
        result.drift.length
          ? `docs check: ${result.drift.length} drifted file(s)\n${result.drift.map((d) => `  - ${d}`).join("\n")}`
          : "docs check: committed generated/ matches fresh emit",
      );
    }
    return result; // check mode never touches the pack
  }

  const manifest = await buildDocsPack({
    repo: service_code,
    ...(existsSync(userGuideDir) ? { docsDir: userGuideDir } : {}),
    outDir: packDir,
    ...(spec ? { openapi: spec } : {}),
  });
  result.pack_files = manifest.files.length;
  if (report) console.log(`docs pack: ${manifest.files.length} file(s)${spec ? " + openapi" : ""} → ${relative(service_root, packDir)}`);
  return result;
}
