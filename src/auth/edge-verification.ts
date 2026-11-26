/**
 * Edge verification helper — the transport-edge half of internal provenance.
 * Buffers the request body exactly once, verifies the provenance signature
 * against those exact bytes, and merges the unsealed sensitive headers back
 * into the request headers — everything downstream (auth chain, routers)
 * sees the identity exactly as if it had arrived in cleartext, while on the
 * wire it never did.
 *
 * Public surface exemption (/health et al.) is the CALLER's responsibility —
 * this helper always verifies.
 */

import type { IncomingMessage } from "node:http";
import { verifyInternalRequest, isSensitiveInternalHeader, type VerifiedProvenance } from "./http-signing.js";
import { isNonceReplay } from "./nonce-cache.js";

export interface EdgeVerifiedRequest {
  provenance: VerifiedProvenance;
  /** The exact body bytes the signature was verified against — downstream
   *  body parsing MUST consume this buffer, never the (now-drained) stream. */
  body: Buffer;
}

/** Buffer + verify + unseal-merge. Throws AuthError — the caller maps to 401. */
export async function verifyEdgeRequest(req: IncomingMessage, url: URL): Promise<EdgeVerifiedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const provenance = await verifyInternalRequest({
    method: req.method ?? "GET",
    path: url.pathname + url.search,
    body: body.length > 0 ? body : undefined,
    getHeader: (name) => {
      const v = req.headers[name.toLowerCase()];
      return typeof v === "string" ? v : undefined;
    },
    isNonceReplay,
  });
  // Strip ANY cleartext sensitive headers first — they are never legitimate
  // on internal hops (the publisher seals them), so their presence is an
  // injection attempt riding alongside a valid signature. Then the unsealed
  // identity re-enters the header surface — downstream unchanged.
  for (const name of Object.keys(req.headers)) {
    if (isSensitiveInternalHeader(name)) delete req.headers[name];
  }
  for (const [name, value] of Object.entries(provenance.sensitiveHeaders)) {
    req.headers[name.toLowerCase()] = value;
  }
  return { provenance, body };
}
