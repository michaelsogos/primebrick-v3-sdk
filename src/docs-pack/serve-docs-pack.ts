/**
 * `docsPackRouteHandler` — serves the built docs pack over HTTP.
 *
 * `GET /api/v1/system/docs/pack` → `{ manifest, files: [{path, content}] }`
 *
 * Protection: `auth: "public"` at route level because the caller is a
 * service, not a user — the real gate is the B11 client-identity shield
 * in `createHttpServer` (User-Agent registry check + client-shield key),
 * which runs before any route. The route is unreachable without a valid
 * service identity.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { makeRpcRouter, type RouteHandler } from "../http/rpc-router.js";
import { parseDocsPackPayload, type DocsPackPayload } from "./manifest.js";

export const DOCS_PACK_ROUTE = "/api/v1/system/docs/pack";

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * @param packDir absolute path of the built pack (e.g. "dist/docs-pack").
 *   Must contain manifest.json + docs/.
 */
export function docsPackRouteHandler(packDir: string): RouteHandler {
  return makeRpcRouter([
    {
      method: "GET",
      path: DOCS_PACK_ROUTE,
      auth: "public",
      openapi: {
        summary: "Serve this service's documentation pack",
        description:
          "Service-to-service endpoint (B11 client-identity gated). Returns the manifest plus the full text of every doc in the pack — pulled by the AI service on service.register for KB ingestion.",
        tags: ["system", "docs"],
      },
      handler: async (): Promise<DocsPackPayload> => {
        const manifestPath = join(packDir, "manifest.json");
        const docsDir = join(packDir, "docs");
        if (!existsSync(manifestPath) || !existsSync(docsDir)) {
          throw new Error(`docs pack not built at ${packDir} — run buildDocsPack first`);
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const files = listFilesRecursive(docsDir).map((full) => ({
          path: relative(docsDir, full).split(sep).join("/"),
          content: readFileSync(full, "utf-8"),
        }));
        const openapiPath = join(packDir, "openapi.json");
        const openapi = existsSync(openapiPath) ? readFileSync(openapiPath, "utf-8") : undefined;
        return parseDocsPackPayload({ manifest, files, openapi });
      },
    },
  ]);
}
