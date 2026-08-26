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
  /** Config value type — drives SDK coercion and FE widget selection. See ConfigType. */
  type: ConfigType;
  /** JSONB-text extra per-type configuration (e.g. badge inline values, list API URL). */
  type_config?: string | null;
  /** Optional i18n translation key for a short title (used by BE/FE for display). */
  label_key?: string;
  /** Optional i18n translation key for a longer description (used by BE/FE for display). */
  description_key?: string;
  /** If true, the row is system-critical: editable but not deletable. */
  reserved?: boolean;
}

/**
 * Config value type vocabulary — single source of truth for SDK coercion
 * and FE widget selection.
 *
 * - `string` / `text` / `url` / `secret` / `json`: string as-is (SDK) / various FE widgets.
 * - `boolean`: SDK coerces via `value === "true"`.
 * - `integer` / `number`: SDK coerces via `parseInt` / `parseFloat`.
 * - `badge`: static set of options defined inline in `type_config.values`.
 * - `list`: dynamic options loaded from a BE API URL in `type_config.api_url`.
 * - `date` / `datetime` / `time`: ISO date/datetime/time strings.
 */
export type ConfigType =
  | "string"
  | "text"
  | "boolean"
  | "integer"
  | "number"
  | "badge"
  | "list"
  | "url"
  | "secret"
  | "json"
  | "date"
  | "datetime"
  | "time";
