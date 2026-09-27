/**
 * Shared cache key + TTL for `api_keys` lookups.
 *
 * Both the BE (`BeApiKeyPort`) and microservices (e.g.
 * `EmailSenderApiKeyPort`) read the same `public.api_keys` table — using
 * ONE shared key means a single warm-up serves every reader and one
 * invalidation would cover all of them.
 */
export const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export function apiKeyCacheKey(hash: string): string {
  return `be:api_keys:hash:${hash}`;
}
