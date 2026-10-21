import type { ConfigRepositoryPort } from "../ports/config-repository-port.js";
import { ValidationError } from "../http/rpc-router.js";

/**
 * Static-identity config keys — values the service treats as part of its
 * deployed identity/discovery coordinates, NOT runtime-tunable settings.
 *
 *   - `service_code`     — resolved statically (package.json / pkg-name
 *                          derivation); a config row survives only as a
 *                          drift tripwire checked at boot.
 *   - `service_base_url` — the discovery coordinate published in
 *                          service_registry (`/ws/<code>` proxy target).
 *                          Provisioned by deployment, not edited at
 *                          runtime: a mid-flight change re-registers the
 *                          service at a new URL and orphans the old one.
 *
 * Any entity-CRUD route that exposes `config_entry` writes MUST reject
 * updates to these keys — call `assertWritableConfigKey` in the update
 * handler (see emailsender's config-route for the canonical wiring).
 */
export const STATIC_SERVICE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "service_code",
  "service_base_url",
]);

/**
 * Throws when `key` is a static-identity config key. Designed for
 * `config_entry` update handlers — a static key is edited by changing the
 * artifact/deployment, never through the admin config UI.
 */
export function assertWritableConfigKey(key: string): void {
  if (STATIC_SERVICE_CONFIG_KEYS.has(key)) {
    throw new ValidationError(
      `Config key "${key}" is static service identity — it cannot be edited at runtime. ` +
        `Change the deployed artifact (package.json/service config) and redeploy.`,
    );
  }
}

/**
 * Dictionary-style config loader backed by a config table.
 * Mirrors BE's loadAuthConfig / getAuthConfig / invalidateAuthConfig pattern
 * (config.ts:150-180), generalized so every microservice can reuse it.
 *
 * DB-agnostic: depends on ConfigRepositoryPort, NOT on any specific DAL.
 * The consumer provides an adapter that implements ConfigRepositoryPort
 * using their DAL (e.g. @primebrick/dal-pg, or raw SQL).
 *
 * Load once at startup → cache in memory → get(key) on hot path (zero DB hits).
 * Call invalidate() to force a reload on next load().
 */
export class ConfigLoader {
  private cache: Map<string, string | null> | null = null;

  constructor(private readonly repo: ConfigRepositoryPort) {}

  /**
   * Load all config rows from DB into in-memory cache.
   * Call once at startup. Throws if DB is unreachable.
   */
  async load(): Promise<Record<string, string | null>> {
    const rows = await this.repo.findAll();
    this.cache = new Map();
    for (const row of rows) {
      this.cache.set(row.key, row.value ?? null);
    }
    return Object.fromEntries(this.cache);
  }

  /**
   * Get a config value from cache. Returns null if key is missing or value is null.
   * Throws if load() has not been called.
   */
  get(key: string): string | null {
    if (this.cache === null) {
      throw new Error("ConfigLoader.load() must be called before get()");
    }
    return this.cache.get(key) ?? null;
  }

  /**
   * Get a config value, throwing if it's missing or empty.
   */
  require(key: string): string {
    const value = this.get(key);
    if (value === null || value === "") {
      throw new Error(`Missing required config key: ${key}`);
    }
    return value;
  }

  /**
   * Get a typed config value via a converter function.
   * Returns null if the key is missing.
   */
  getTyped<T>(key: string, converter: (v: string) => T): T | null {
    const value = this.get(key);
    if (value === null) return null;
    return converter(value);
  }

  /**
   * Get a typed config value, throwing if it's missing.
   */
  requireTyped<T>(key: string, converter: (v: string) => T): T {
    const value = this.require(key);
    return converter(value);
  }

  /**
   * Get all config as a plain object.
   */
  getAll(): Record<string, string | null> {
    if (this.cache === null) {
      throw new Error("ConfigLoader.load() must be called before getAll()");
    }
    return Object.fromEntries(this.cache);
  }

  /**
   * Invalidate the cache so the next load() re-reads from DB.
   */
  invalidate(): void {
    this.cache = null;
  }
}
