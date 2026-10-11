/**
 * `buildDocsPack` — builds `dist/docs-pack/` from a repo's docs directory.
 *
 * Runs at build time (each repo wires it into its own `generate:docs` /
 * build script). Copies the docs tree verbatim, then runs the repo's
 * `GenerateDocsFn`s to emit metadata-derived pages into the same tree,
 * and finally writes manifest.json with per-file sha256.
 *
 * The SDK owns the contract + runner; each repo owns its content
 * extractors (e.g. BE: *.meta.ts → entity-field-reference).
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DOCS_PACK_SCHEMA_VERSION,
  type DocsPackFile,
  type DocsPackManifest,
} from "./manifest.js";

/** A generated doc emitted by a repo's extractor. */
export interface GeneratedDoc {
  /** Path relative to the pack root (e.g. "generated/entity-field-reference.mdx"). */
  path: string;
  content: string;
}

/** Context handed to each generator — repos read their own metadata. */
export interface GenerateDocsContext {
  /** Repo/service code as declared in the manifest. */
  repo: string;
  /** Absolute path of the pack output dir (already contains raw docs). */
  outDir: string;
}

export type GenerateDocsFn = (ctx: GenerateDocsContext) => Promise<GeneratedDoc[]>;

export interface BuildDocsPackOptions {
  /** Repo/service code written into the manifest (KB ingest key). */
  repo: string;
  /** Source docs directory (e.g. "docs/user-guide") — copied verbatim. */
  docsDir: string;
  /** Output dir (e.g. "dist/docs-pack"). Recreated each build. */
  outDir: string;
  /** Metadata-derived doc generators — run after the raw copy. */
  generators?: GenerateDocsFn[];
  /** Optional OpenAPI spec source — copied to outDir/openapi.json. */
  openapiPath?: string;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function buildDocsPack(opts: BuildDocsPackOptions): Promise<DocsPackManifest> {
  const { repo, docsDir, outDir, generators = [], openapiPath } = opts;
  if (!existsSync(docsDir)) {
    throw new Error(`buildDocsPack: docsDir not found: ${docsDir}`);
  }

  mkdirSync(outDir, { recursive: true });
  const docsOut = join(outDir, "docs");
  cpSync(docsDir, docsOut, { recursive: true });

  for (const gen of generators) {
    const docs = await gen({ repo, outDir });
    for (const doc of docs) {
      const target = join(docsOut, doc.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, doc.content, "utf-8");
    }
  }

  let hasOpenapi = false;
  if (openapiPath && existsSync(openapiPath)) {
    cpSync(openapiPath, join(outDir, "openapi.json"));
    hasOpenapi = true;
  }

  const files: DocsPackFile[] = listFilesRecursive(docsOut).map((full) => {
    const rel = relative(docsOut, full).split(sep).join("/");
    const content = readFileSync(full);
    return { path: rel, sha256: sha256(content), bytes: content.byteLength };
  });

  const manifest: DocsPackManifest = {
    schema: DOCS_PACK_SCHEMA_VERSION,
    repo,
    generated_at: new Date().toISOString(),
    files,
    has_openapi: hasOpenapi || undefined,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}
