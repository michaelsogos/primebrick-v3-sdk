/**
 * Translations module — framework-agnostic i18n service + cache helpers.
 *
 * DB-agnostic: does NOT import from @primebrick/dal-pg.
 * The BE resolves entity metadata (schema, qualified table name) and passes
 * it to the service methods.
 */

export {
  TranslationsCache,
  i18nCacheKey,
  type I18nDict,
} from "./translations-cache.js";

export {
  TranslationsService,
  type TranslationsRepository,
  type TranslationsServiceOptions,
  type TranslationRow,
  type Queryable,
} from "./translations-service.js";
