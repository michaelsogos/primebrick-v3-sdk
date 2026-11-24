/**
 * Docs-pack contract — the manifest describing a service's documentation
 * bundle, built at build time and pulled by the AI service on registration.
 *
 * Pack layout on disk (`dist/docs-pack/`):
 *
 * ```
 * manifest.json      — this schema
 * docs/...           — raw .mdx/.md files + _order.json (verbatim source)
 * openapi.json       — optional service OpenAPI spec
 * ```
 *
 * Wire format (`GET /api/v1/system/docs/pack`):
 *
 * ```ts
 * { manifest: DocsPackManifest, files: [{ path, content }] }
 * ```
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
  /** Raw openapi.json content, when the pack carries one. */
  openapi?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`invalid docs pack payload: ${msg}`);
}

/**
 * Wire integers arrive as bigint (ext-json codec) — accept both, coerce to
 * number, reject everything else. The returned payload must honor its
 * declared `number` types, never smuggle bigint downstream.
 */
function asInt(v: unknown, what: string): number {
  const n = typeof v === "bigint" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) fail(`${what} not an integer`);
  return n;
}

export function parseDocsPackPayload(raw: unknown): DocsPackPayload {
  if (!isRecord(raw)) fail("payload is not an object");
  const m = raw.manifest;
  if (!isRecord(m)) fail("manifest missing");
  const schema = asInt(m.schema, "schema");
  if (schema !== DOCS_PACK_SCHEMA_VERSION) fail(`unsupported schema ${String(m.schema)}`);
  if (typeof m.repo !== "string" || !m.repo) fail("manifest.repo missing");
  if (typeof m.generated_at !== "string") fail("manifest.generated_at missing");
  if (!Array.isArray(m.files)) fail("manifest.files missing");
  const manifestFiles: DocsPackFile[] = m.files.map((f) => {
    if (!isRecord(f) || typeof f.path !== "string" || !f.path) fail("manifest.files[].path invalid");
    if (typeof f.sha256 !== "string" || f.sha256.length !== 64) fail(`manifest file ${f.path}: bad sha256`);
    const bytes = asInt(f.bytes, `manifest file ${f.path}: bytes`);
    if (bytes < 0) fail(`manifest file ${f.path}: bad bytes`);
    return { path: f.path, sha256: f.sha256, bytes };
  });
  if (!Array.isArray(raw.files)) fail("files missing");
  for (const f of raw.files) {
    if (!isRecord(f) || typeof f.path !== "string" || !f.path) fail("files[].path invalid");
    if (typeof f.content !== "string") fail(`file ${f.path}: content not a string`);
  }
  if (raw.openapi !== undefined && typeof raw.openapi !== "string") fail("openapi not a string");
  return {
    manifest: {
      schema: DOCS_PACK_SCHEMA_VERSION,
      repo: m.repo,
      generated_at: m.generated_at,
      files: manifestFiles,
      ...(m.has_openapi === true ? { has_openapi: true as const } : {}),
    },
    files: raw.files as DocsPackContentFile[],
    ...(typeof raw.openapi === "string" ? { openapi: raw.openapi } : {}),
  };
}
