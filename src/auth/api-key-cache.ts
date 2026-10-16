/**
 * Shared cache key + TTL for `api_keys` lookups.
 *
 * Every cached `ApiKeyPort` is a `CachingApiKeyPort`: the BE resolves
 * `public.api_keys` directly, microservices resolve via the governed
 * `auth.apikey.byHash` NATS route — but all of them cache under the SAME
 * key, so a single warm-up serves every reader and one invalidation would
 * cover all of them.
 */
export const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export function apiKeyCacheKey(hash: string): string {
  return `be:api_keys:hash:${hash}`;
}
