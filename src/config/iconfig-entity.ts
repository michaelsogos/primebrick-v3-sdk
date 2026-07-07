/**
 * Shape of a dictionary-style config row. Every microservice config table
 * mirrors this: one row per key, value stored as TEXT, type conversion
 * performed at read time by ConfigLoader consumers.
 *
 * Self-contained — does NOT extend IAuditableEntity from @primebrick/dal-pg.
 * The SDK is DB-agnostic; audit fields are a DAL-specific concern handled
 * by the consumer's entity class and adapter.
 */
export interface IConfigEntity {
  /** Unique config key, e.g. "brevo_api_key". */
  key: string;
  /** Raw TEXT value. null means "not set yet". Type conversion at read time. */
  value: string | null;
  /** Optional i18n translation key for a short title (used by BE/FE for display). */
  label_key?: string;
  /** Optional i18n translation key for a longer description (used by BE/FE for display). */
  description_key?: string;
}
