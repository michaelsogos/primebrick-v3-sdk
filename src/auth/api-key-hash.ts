/**
 * SHA-256 hashing for API keys.
 *
 * API keys are never stored in plaintext. The `api_keys` table stores only
 * the SHA-256 hash. This module provides the hashing function used by both
 * the key generation side (BE admin UI) and the verification side (SDK
 * verifyApiKey()).
 */

import { createHash } from "node:crypto";

/**
 * Hash an API key string using SHA-256.
 * Returns a hex-encoded string.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Generate a new random API key string.
 * Format: `pbk_<32 random hex chars>` (36 chars total, 8-char prefix for display).
 */
export function generateApiKey(): { key: string; prefix: string } {
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const random = randomBytes(16).toString("hex");
  const key = `pbk_${random}`;
  const prefix = key.slice(0, 12) + "...";
  return { key, prefix };
}
