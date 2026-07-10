/**
 * Cached auth configuration loader.
 *
 * The AuthConfigPort implementation is injected at startup via initAuthConfig().
 * The config is loaded once into an in-memory cache and reused on the hot path.
 */

import type { AuthConfig } from "./types.js";
import type { AuthConfigPort } from "./ports/auth-config-port.js";

let cached: AuthConfig | null = null;
let port: AuthConfigPort | null = null;

/**
 * Initialize the auth config with a port implementation.
 * Called once at application startup.
 */
export function initAuthConfig(p: AuthConfigPort): void {
  port = p;
}

/**
 * Load auth config from the port into the in-memory cache.
 * Called once at startup (and on invalidation).
 * Throws if the port is not initialized or the DB is unreachable.
 */
export async function loadAuthConfig(): Promise<AuthConfig> {
  if (!port) {
    throw new Error("AuthConfigPort not initialized. Call initAuthConfig() first.");
  }
  cached = await port.load();
  return cached;
}

/**
 * Return the cached config. Throws if not loaded yet.
 * Does NOT touch the DB on the hot path.
 */
export function getAuthConfig(): AuthConfig {
  if (!cached) {
    throw new Error(
      "Auth configuration is not loaded. Call loadAuthConfig() at startup.",
    );
  }
  return cached;
}

/** Invalidate the cache so the next loadAuthConfig() re-reads from the port. */
export function invalidateAuthConfig(): void {
  cached = null;
}

/** Test helper alias (backward compat). */
export const resetAuthConfigForTest = invalidateAuthConfig;
