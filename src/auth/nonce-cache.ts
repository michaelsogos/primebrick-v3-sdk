/**
 * Anti-replay nonce cache for internal HTTP provenance (D6 ratified).
 *
 * Contract: the verifier asks `isNonceReplay(service, nonce)` for every
 * WRITE-method internal request; the first occurrence registers the nonce
 * and returns false, a repeat within the skew window returns true and the
 * request dies with AUTH_REPLAY_DETECTED. GET/HEAD never consult it — the
 * replay of a read is inert by construction.
 *
 * Backends:
 *   - Redis (`SET key NX PX`) when a shared client is already connected —
 *     correct across multi-replica deployments, one roundtrip per write;
 *   - in-memory sliding window otherwise (dev-standalone, tests) — correct
 *     for single-instance processes, zero cost.
 *
 * The window is the signature skew (30s) plus margin — a nonce that expires
 * can only be replayed together with a timestamp that is itself already
 * stale, so expiry never reopens the window.
 */

import { getRedisClient } from "../cache/redis-client.js";
import { SIGNATURE_SKEW_MS } from "./http-signing.js";

/** TTL = skew window + margin so expiry can never precede timestamp staleness. */
const NONCE_TTL_MS = SIGNATURE_SKEW_MS + 15_000;

const KEY_PREFIX = "pb:nonce:";

// --- in-memory sliding window (fallback backend) ---

const memoryStore = new Map<string, number>();
let lastSweep = 0;

function memoryIsReplay(key: string): boolean {
  const now = Date.now();
  if (now - lastSweep > NONCE_TTL_MS) {
    for (const [k, at] of memoryStore) if (now - at > NONCE_TTL_MS) memoryStore.delete(k);
    lastSweep = now;
  }
  if (memoryStore.has(key)) return true;
  memoryStore.set(key, now);
  return false;
}

/**
 * Register-or-report the nonce. True = already seen (replay). False = first
 * sighting, now recorded. Fail-CLOSED on Redis errors: a verifier that cannot
 * check replays must reject rather than wave through — same doctrine as the
 * signature itself.
 */
export async function isNonceReplay(service: string, nonce: string): Promise<boolean> {
  const key = `${KEY_PREFIX}${service}:${nonce}`;
  const redis = getRedisClient();
  if (!redis) return memoryIsReplay(key);
  try {
    // SET key "1" PX ttl NX — "OK" when first sighted, null when present.
    const result = await redis.set(key, "1", { PX: NONCE_TTL_MS, NX: true });
    return result === null;
  } catch {
    // fail-closed: unreachable cache = replay protection unverifiable = reject
    return true;
  }
}

/** Test-only hook — clears the in-memory fallback store. */
export function resetNonceCacheForTest(): void {
  memoryStore.clear();
  lastSweep = 0;
}
