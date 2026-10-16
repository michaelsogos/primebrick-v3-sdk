/**
 * HTTP header names and Cache-Control directives for the Primebrick cache protocol.
 *
 * The BE sets these headers on cached responses so the FE can:
 * - discover that a response is cacheable (`X-PB-Cached: true`)
 * - know which storage to use (`X-PB-Cache-Scope: local` or `session`)
 * - validate freshness via standard `ETag` / `If-None-Match`
 */

/** HTTP header names used by the Primebrick cache protocol. */
export const CACHE_HEADERS = {
  /** Standard ETag header — the response validator. */
  ETAG: "ETag",
  /** Standard conditional request header — sent by the FE to revalidate. */
  IF_NONE_MATCH: "If-None-Match",
  /** Custom header: tells the FE this response is cacheable. */
  PB_CACHED: "X-PB-Cached",
  /** Custom header: tells the FE the cache scope (local vs session). */
  PB_CACHE_SCOPE: "X-PB-Cache-Scope",
} as const;

/** Cache scope — which browser storage the FE should use. */
export type CacheScope = "local" | "session";

/**
 * Cache-Control directive for cached GET responses.
 *
 * `private, no-cache, must-revalidate` means:
 * - `private` — only the browser may cache (not shared proxies/CDNs)
 * - `no-cache` — the browser MUST revalidate with the server before using a cached copy
 * - `must-revalidate` — once stale, the browser MUST not serve stale without revalidation
 *
 * This is the correct directive for ETag-based caching — it prevents the browser
 * from serving stale responses without asking the server first (via `If-None-Match`).
 */
export const CACHE_CONTROL_CACHED = "private, no-cache, must-revalidate";
