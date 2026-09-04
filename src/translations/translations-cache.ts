/**
 * Translations cache — Redis cache helpers for i18n dicts.
 *
 * Cache key includes the schema (module boundary) so `public.translations:it-IT`
 * and `system.translations:it-IT` don't collide.
 *
 * The i18n dict is a **flat dict** (`Record<string, string>`) — keys are full
 * dot-paths, values are translated strings. Built by PG's `jsonb_object_agg`.
 *
 * This module is DB-agnostic — it does NOT import from @primebrick/dal-pg.
 * The schema name is passed in by the consumer (BE resolves it from entity metadata).
 */

import type { CachePort } from "../cache/cache-port.js";

/** Flat i18n dict — keys are full dot-paths (e.g. "app.auth.login.title"). */
export type I18nDict = Record<string, string>;

/** Cache key format: `translations:i18n:{schema}:{language}` */
export function i18nCacheKey(schema: string, language: string): string {
  return `translations:i18n:${schema}:${language}`;
}

/**
 * TTL: 6 hours (21_600_000 ms) — translations change rarely; invalidation-on-write
 * handles freshness in the normal case. TTL is a safety net for edge cases
 * (Redis down during write, direct DB edits). 6h limits stale data to 6h
 * while reducing DB reads 6x vs a 1h TTL (3.5 vs 21 queries/hour).
 */
const I18N_CACHE_TTL = 21_600_000;

export class TranslationsCache {
  constructor(
    private readonly port: CachePort | null,
    private readonly schema: string,
  ) {}

  async getI18nDict(language: string): Promise<I18nDict | null> {
    if (!this.port) return null;
    try {
      return await this.port.get<I18nDict>(i18nCacheKey(this.schema, language));
    } catch {
      return null;
    }
  }

  async setI18nDict(language: string, dict: I18nDict): Promise<void> {
    if (!this.port) return;
    try {
      await this.port.set(i18nCacheKey(this.schema, language), dict, I18N_CACHE_TTL);
    } catch {
      // best-effort — cache is a feature, not a requirement
    }
  }

  async invalidate(language?: string): Promise<void> {
    if (!this.port) return;
    try {
      if (language) {
        await this.port.del(i18nCacheKey(this.schema, language));
      } else {
        // Invalidate all languages for this schema
        await this.port.delByPrefix(`translations:i18n:${this.schema}:`);
      }
    } catch {
      // best-effort — if Redis is down, the 6h TTL is the safety net
    }
  }
}
