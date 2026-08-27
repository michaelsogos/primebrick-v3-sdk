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
  /** Optional grouping key for UI display. null/empty = ungrouped (top of list). */
  group_key?: string | null;
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

// ─── Validation rules (type_config.validation) ─────────────────────────────

/**
 * Validation rules for a config row, stored inside `type_config` JSON under
 * the `validation` key. This is the shared schema used by SDK consumers (BE,
 * microservices) and the FE JSON-to-Zod builder.
 *
 * Example type_config JSON:
 * ```json
 * {
 *   "values": { ... },
 *   "validation": {
 *     "required": true,
 *     "rules": {
 *       "min": { "value": 1, "error_label_key": "config.auth.x.errors.min" },
 *       "max": { "value": 90, "error_label_key": "config.auth.x.errors.max" }
 *     }
 *   }
 * }
 * ```
 */
export interface ConfigValidation {
  /** If true, empty/null values are rejected (except secrets with empty = "leave unchanged"). */
  required: boolean;
  /** Optional i18n key for the required error message. Falls back to "validation.required". */
  required_error_label_key?: string;
  /** Map of rule type → rule config. Each rule has its own error_label_key for i18n. */
  rules: ConfigValidationRules;
}

export interface ConfigValidationRules {
  /** Minimum value (for integer/number) or minimum length (for string/secret). */
  min?: ValidationRuleMin;
  /** Maximum value (for integer/number) or maximum length (for string/secret). */
  max?: ValidationRuleMax;
  /** URL protocol validation (for url type). */
  url?: ValidationRuleUrl;
  /** Email format validation (for string type). */
  email?: ValidationRuleEmail;
  /** Regex pattern validation (for string/secret type). */
  regex?: ValidationRuleRegex;
}

export interface ValidationRuleMin {
  value: number;
  error_label_key: string;
}

export interface ValidationRuleMax {
  value: number;
  error_label_key: string;
}

export interface ValidationRuleUrl {
  /** Allowed URL protocols, e.g. ["http", "https", "redis", "rediss", "tcp"]. */
  protocols: string[];
  error_label_key: string;
}

export interface ValidationRuleEmail {
  error_label_key: string;
}

export interface ValidationRuleRegex {
  /** Regex pattern string (parsed via new RegExp(pattern)). */
  pattern: string;
  error_label_key: string;
}
