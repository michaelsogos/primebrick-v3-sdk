/**
 * Translations service — framework-agnostic CRUD + i18n read logic.
 *
 * Takes a DAL Repository (for CRUD) and a Queryable (for the jsonb_object_agg
 * read) as constructor params. The BE resolves the qualified table name from
 * DAL entity metadata and passes it to getI18nDict — the SDK does NOT import
 * from @primebrick/dal-pg.
 *
 * The jsonb_object_agg query uses the BE-resolved table name (safe, no string
 * interpolation by the SDK) and a parameterized language value:
 *
 *   SELECT jsonb_object_agg(key, value) AS dict
 *   FROM "public"."translations"   ← passed by BE from getQualifiedTableName(entity)
 *   WHERE language = $1 AND deleted_at IS NULL
 *
 * This is NOT "raw SQL with schema interpolation" — the table name comes from
 * DAL metadata (compile-time @Entity decorator), the language is a parameter.
 * The DAL's Repository itself uses the same db.query() pattern internally.
 */

import { TranslationsCache, type I18nDict } from "./translations-cache.js";
import type { CachePort } from "../cache/cache-port.js";

/** Row shape returned by the DAL Repository for translation entities. */
export interface TranslationRow {
  id: bigint | string;
  uuid: string;
  key: string;
  language: string;
  value: string;
  created_at?: Date | string;
  created_by?: string;
  updated_at?: Date | string;
  updated_by?: string;
  version?: number;
  deleted_at?: Date | string | null;
  deleted_by?: string | null;
}

/**
 * Structural interface — a DAL Repository satisfies this without any import.
 * TypeScript structural typing: if it has these methods, it's assignable.
 */
export interface TranslationsRepository {
  findByPage(
    entity: unknown,
    resultCtor: unknown,
    options: {
      filters?: Array<{ field: string; op: string; value: unknown }>;
      page?: number;
      page_size?: number;
      sort_key?: string;
      sort_dir?: string;
      deleted_records?: string;
    },
  ): Promise<{ rows: TranslationRow[]; total: bigint }>;
  create(
    entity: unknown,
    data: Partial<TranslationRow>,
    options: { actor: string },
  ): Promise<TranslationRow>;
  update(
    entity: unknown,
    uuid: string,
    data: Partial<TranslationRow>,
    options: { actor: string },
  ): Promise<TranslationRow>;
  softDelete(entity: unknown, uuid: string, options: { actor: string }): Promise<void>;
  restore(entity: unknown, uuid: string, options: { actor: string }): Promise<void>;
}

/** Queryable — same type the DAL Repository uses (Pick<Pool, "query">). */
export type Queryable = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

export interface TranslationsServiceOptions {
  repository: TranslationsRepository;
  queryable: Queryable;
  cachePort: CachePort | null;
}

export class TranslationsService {
  private readonly caches = new Map<string, TranslationsCache>();

  constructor(private readonly opts: TranslationsServiceOptions) {}

  /** Get or create a cache for a specific schema. */
  private getCache(schema: string): TranslationsCache {
    let cache = this.caches.get(schema);
    if (!cache) {
      cache = new TranslationsCache(this.opts.cachePort, schema);
      this.caches.set(schema, cache);
    }
    return cache;
  }

  /**
   * Get the flat i18n dict for a language from a specific module's schema.
   * PG builds the dict natively via jsonb_object_agg — no Node-side post-processing.
   * Cache-first; falls back to DB on miss.
   *
   * @param entity - The DAL entity class (used by the Repository for CRUD)
   * @param schema - The schema name (e.g. "public", "system") — for cache keying
   * @param qualifiedTable - The schema-qualified table name (e.g. "public"."translations")
   *                         — resolved by the BE from getQualifiedTableName(entity)
   * @param language - BCP 47 language tag (e.g. "it-IT")
   */
  async getI18nDict(
    entity: unknown,
    schema: string,
    qualifiedTable: string,
    language: string,
  ): Promise<I18nDict> {
    const cache = this.getCache(schema);
    const cached = await cache.getI18nDict(language);
    if (cached) return cached.data;

    const result = await this.opts.queryable.query(
      `SELECT jsonb_object_agg(key, value) AS dict FROM ${qualifiedTable} WHERE language = $1 AND deleted_at IS NULL`,
      [language],
    );
    const dict = (result.rows[0]?.dict ?? {}) as I18nDict;
    await cache.setI18nDict(language, dict);
    return dict;
  }

  async list(
    entity: unknown,
    schema: string,
    query: { page?: number; page_size?: number; language?: string },
  ) {
    const filters: Array<{ field: string; op: string; value: unknown }> = [];
    if (query.language) {
      filters.push({ field: "language", op: "=", value: query.language });
    }
    return this.opts.repository.findByPage(entity, entity, {
      filters,
      page: query.page ?? 1,
      page_size: query.page_size ?? 25,
      deleted_records: "EXCLUDED",
    });
  }

  async create(
    entity: unknown,
    schema: string,
    data: { key: string; language: string; value: string },
    actor: string,
  ) {
    const row = await this.opts.repository.create(entity, data, { actor });
    await this.getCache(schema).invalidate(data.language);
    return row;
  }

  async update(
    entity: unknown,
    schema: string,
    uuid: string,
    data: { key?: string; language?: string; value?: string },
    actor: string,
  ) {
    const row = await this.opts.repository.update(entity, uuid, data, { actor });
    await this.getCache(schema).invalidate();
    return row;
  }

  async softDelete(entity: unknown, schema: string, uuid: string, actor: string) {
    await this.opts.repository.softDelete(entity, uuid, { actor });
    await this.getCache(schema).invalidate();
  }

  async restore(entity: unknown, schema: string, uuid: string, actor: string) {
    await this.opts.repository.restore(entity, uuid, { actor });
    await this.getCache(schema).invalidate();
  }
}
