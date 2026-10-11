/**
 * Docs-pack contract — the manifest describing a service's documentation
 * bundle, built at build time and pulled by the AI service on registration.
 *
 * Pack layout on disk (`dist/docs-pack/`):
 *   manifest.json      — this schema
 *   docs/...           — raw .mdx/.md files + _order.json (verbatim source)
 *   openapi.json       — optional service OpenAPI spec
 *
 * Wire format (`GET /api/v1/system/docs/pack`):
 *   { manifest: DocsPackManifest, files: [{ path, content }] }
 *
 * Text is always the source of truth — no precomputed vectors in the
 * contract (embeddings are model-bound; the consumer re-embeds).
 */

export const DOCS_PACK_CAPABILITY = "docs_pack";
export const DOCS_PACK_SCHEMA_VERSION = 1;

export interface DocsPackFile {
  path: string;
  /** sha256 hex of the file content — incremental ingest key. */
  sha256: string;
  bytes: number;
}

export interface DocsPackManifest {
  schema: typeof DOCS_PACK_SCHEMA_VERSION;
  /** Owning repo/service code — the KB ingest key (e.g. "ai", "be"). */
  repo: string;
  generated_at: string;
  /** Doc-relative paths (e.g. "dev-guide/index.mdx") with content hashes. */
  files: DocsPackFile[];
  /** Present when the pack carries an openapi.json at root. */
  has_openapi?: boolean;
}

/** One file of pack content — wire format. */
export interface DocsPackContentFile {
  /** Path relative to the pack's docs/ dir (e.g. "dev-guide/index.mdx"). */
  path: string;
  /** UTF-8 file content — the KB's source of truth. */
  content: string;
}

export interface DocsPackPayload {
  manifest: DocsPackManifest;
  files: DocsPackContentFile[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`invalid docs pack payload: ${msg}`);
}

export function parseDocsPackPayload(raw: unknown): DocsPackPayload {
  if (!isRecord(raw)) fail("payload is not an object");
  const m = raw.manifest;
  if (!isRecord(m)) fail("manifest missing");
  if (m.schema !== DOCS_PACK_SCHEMA_VERSION) fail(`unsupported schema ${String(m.schema)}`);
  if (typeof m.repo !== "string" || !m.repo) fail("manifest.repo missing");
  if (typeof m.generated_at !== "string") fail("manifest.generated_at missing");
  if (!Array.isArray(m.files)) fail("manifest.files missing");
  for (const f of m.files) {
    if (!isRecord(f) || typeof f.path !== "string" || !f.path) fail("manifest.files[].path invalid");
    if (typeof f.sha256 !== "string" || f.sha256.length !== 64) fail(`manifest file ${f.path}: bad sha256`);
    if (typeof f.bytes !== "number" || f.bytes < 0) fail(`manifest file ${f.path}: bad bytes`);
  }
  if (!Array.isArray(raw.files)) fail("files missing");
  for (const f of raw.files) {
    if (!isRecord(f) || typeof f.path !== "string" || !f.path) fail("files[].path invalid");
    if (typeof f.content !== "string") fail(`file ${f.path}: content not a string`);
  }
  return raw as unknown as DocsPackPayload;
}
