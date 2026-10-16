/**
 * ETag computation and comparison helpers.
 *
 * Two strategies:
 * - `computeETag` — SHA-256 hash of the ext-JSON representation (strong, content-based).
 * - `computeVersionETag` — cheap ETag from an entity `version` field (fast, version-based).
 *
 * ETags are quoted per RFC 7232 (e.g. `"abc123"`). Weak ETags (`W/"abc123"`) are
 * supported by `etagMatches` — the `W/` prefix is stripped before comparison.
 */

import { createHash } from "node:crypto";
import { extJsonStringify } from "../json/ext-json.js";
import type { CacheEntry } from "./cache-entry.js";

/**
 * Compute a strong ETag from any serializable value.
 * Uses SHA-256 (first 16 hex chars) of the ext-JSON representation.
 *
 * BigInt values are serialized correctly via `extJsonStringify`.
 */
export function computeETag(value: unknown): string {
  const json = extJsonStringify(value);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  return `"${hash}"`;
}

/**
 * Compute a cheap ETag from an entity version field.
 * Faster than hashing — use when the entity has `version: number`.
 */
export function computeVersionETag(version: number | string): string {
  return `"v${version}"`;
}

/**
 * Wrap a value + ETag into a `CacheEntry` for Redis storage.
 * If `etag` is omitted, it is computed via `computeETag`.
 */
export function wrapCacheEntry<T>(data: T, etag?: string): CacheEntry<T> {
  return {
    data,
    etag: etag ?? computeETag(data),
    cached_at: Date.now(),
  };
}

/**
 * Check if a request ETag matches a cached ETag.
 * Handles weak ETags (`W/"..."`) and strong ETags (`"..."`).
 * The `W/` prefix is stripped before comparison — a weak ETag matches
 * a strong ETag with the same hash (per RFC 7232 weak comparison).
 */
export function etagMatches(requestETag: string | null, cachedETag: string): boolean {
  if (!requestETag) return false;
  const normalize = (e: string) => e.replace(/^W\//, "").trim();
  return normalize(requestETag) === normalize(cachedETag);
}
