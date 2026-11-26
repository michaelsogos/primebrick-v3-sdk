/**
 * `fetchDocsPack` — pull a service's docs pack over governed internal HTTP.
 *
 * Uses `internalFetch`, so the caller's service-identity headers
 * (User-Agent + client-shield key) are always attached — the only legal
 * way to reach another service's pack endpoint.
 *
 * Additionally stamps the rotating client-shield secret: the BE's pack
 * route (a service-to-service endpoint without user context) is gated by
 * that secret, which the secret engine provisions to every consumer.
 */

import { internalFetch } from "../http/internal-client.js";
import { extJsonParse } from "../json/ext-json.js";
import { DOCS_PACK_ROUTE } from "./serve-docs-pack.js";
import { parseDocsPackPayload, type DocsPackPayload } from "./manifest.js";


export async function fetchDocsPack(serviceBaseUrl: string): Promise<DocsPackPayload> {
  const url = new URL(DOCS_PACK_ROUTE, serviceBaseUrl);
  const res = await internalFetch(url, {
  });
  if (!res.ok) {
    throw new Error(`docs pack fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return parseDocsPackPayload(extJsonParse(await res.text()));
}
