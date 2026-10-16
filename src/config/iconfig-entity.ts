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
  /** JSONB-text extra per-type configuration (e.g. badge inline values, select API URL). */
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
 * - `bigint` / `number`: SDK coerces via `BigInt` / `Number`.
 * - `money`: SDK coerces via `Number` (amount only; currency is in `type_config`).
 * - `badge`: static set of options defined inline in `type_config.values`.
 * - `single_select`: single-selection dropdown (was `list`). Options from `type_config.api_url` or `type_config.values_source`.
 * - `multi_select`: multi-selection dropdown. Options from `type_config.api_url` or `type_config.values_source`. Value stored as comma-separated string.
 * - `email`: validated as RFC 5322 simplified email. Stored as string.
 * - `phone`: validated as E.164 via `libphonenumber-js`. Stored as string.
 * - `date` / `datetime` / `time`: ISO date/datetime/time strings.
 */
export type ConfigType =
  | "string"
  | "text"
  | "boolean"
  | "bigint"
  | "number"
  | "money"
  | "badge"
  | "single_select"
  | "multi_select"
  | "url"
  | "secret"
  | "json"
  | "date"
  | "datetime"
  | "time"
  | "email"
  | "phone";

/**
 * type_config shape for `money` config type.
 * The amount is stored in the `value` column (as a TEXT string);
 * the currency and optional allowed-currencies list live in `type_config` JSON.
 */
export interface ConfigTypeMoneyConfig {
  /** ISO 4217 currency code, e.g. "EUR", "USD". Set by user, stored in type_config. */
  currency: string;
  /** Optional: restrict selectable currencies. If absent, all ISO 4217 codes are allowed. */
  allowed_currencies?: string[];
}

/**
 * type_config shape for `url` config type.
 * The URL is stored in the `value` column; the default protocol and
 * allowed-protocols list live in `type_config` JSON.
 */
export interface ConfigTypeUrlConfig {
  /** Default protocol prepended when the user doesn't type one. e.g. "https". */
  default_protocol: string;
  /** Allowed URL protocols, e.g. ["http", "https", "redis", "rediss", "tcp"]. */
  allowed_protocols: string[];
}

/**
 * type_config shape for `phone` config type.
 * The phone number is stored in the `value` column (E.164 format);
 * the country code and optional allowed-countries list live in `type_config` JSON.
 */
export interface ConfigTypePhoneConfig {
  /** ISO 3166-1 alpha-2 country code, e.g. "IT", "US". Drives formatting and validation. */
  country: string;
  /** Optional: restrict selectable countries. If absent, all countries are allowed. */
  allowed_countries?: string[];
}

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
  /** Optional i18n key for the required error message. Falls back to "app.common.validation.required". */
  required_error_label_key?: string;
  /**
   * If true, numeric values (bigint/number/money) are treated as unsigned:
   * - Sign characters (`-`, `+`) are rejected at the type-validation level.
   * - The effective minimum defaults to 0 when no explicit `rules.min` is set.
   * Absent or false → signed (default, backward compatible).
   * Only `unsigned: true` activates unsigned behavior.
   */
  unsigned?: boolean;
  /** Map of rule type → rule config. Each rule has its own error_label_key for i18n. */
  rules: ConfigValidationRules;
}

export interface ConfigValidationRules {
  /** Minimum value (for bigint/number/money) or minimum length (for string/secret/url/email/phone). */
  min?: ValidationRuleMin;
  /** Maximum value (for bigint/number/money) or maximum length (for string/secret/url/email/phone). */
  max?: ValidationRuleMax;
  /**
   * URL protocol validation.
   * @deprecated Use TYPE `url` with `type_config.allowed_protocols` instead.
   * Kept for backward compatibility — still validated for `type === "url"`.
   */
  url?: ValidationRuleUrl;
  /**
   * Email format validation.
   * @deprecated Use TYPE `email` instead. Email validation is now inherent to the type.
   * Kept for backward compatibility — still validated for `type === "email"`.
   */
  email?: ValidationRuleEmail;
  /** Regex pattern validation (for string/text/secret/url/email/phone). */
  regex?: ValidationRuleRegex;
}

export interface ValidationRuleMin {
  value: number | bigint;
  error_label_key: string;
}

export interface ValidationRuleMax {
  value: number | bigint;
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
  /** Regex pattern string (parsed via new RegExp(pattern, flags)). */
  pattern: string;
  /**
   * Regex flags passed as the second argument to `new RegExp(pattern, flags)`.
   * Common values: "g" (global), "i" (ignore case), "m" (multiline).
   * Empty string or undefined = no flags. Flags are NOT parsed from the pattern string.
   */
  flags?: string;
  error_label_key: string;
}
