/**
 * SHA-256 hashing for API keys.
 *
 * API keys are never stored in plaintext. The `api_keys` table stores only
 * the SHA-256 hash. This module provides the hashing function used by both
 * the key generation side (BE admin UI) and the verification side (SDK
 * verifyApiKey()).
 *
 * Runtime-agnostic: prefers `Bun.CryptoHasher` (native, sync) when the
 * process runs on Bun — which is every US microservice — and falls back to
 * `node:crypto` on Node (the BE today). Signature stays sync either way.
 */

import { createHash } from "node:crypto";

interface BunCryptoHasher {
  update(data: string): this;
  digest(encoding: "hex"): string;
}

const BunHasher = (
  globalThis as { Bun?: { CryptoHasher?: new (algo: string) => BunCryptoHasher } }
).Bun?.CryptoHasher;

/**
 * Hash an API key string using SHA-256.
 * Returns a hex-encoded string.
 */
export function hashApiKey(key: string): string {
  if (BunHasher) {
    const h = new BunHasher("sha256");
    h.update(key);
    return h.digest("hex");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Generate a new random API key string.
 * Format: `pbk_<32 random hex chars>` (36 chars total, 8-char prefix for display).
 */
export function generateApiKey(): { key: string; prefix: string } {
  // No caller exists today — the previous implementation used `require()`
  // which crashes under ESM/Bun. Re-implement when the admin mint-key
  // endpoint lands (WebCrypto `crypto.getRandomValues`, runtime-agnostic).
  throw new Error("generateApiKey(): not implemented yet");
}
