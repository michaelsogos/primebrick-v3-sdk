/**
 * Config value validator — shared validation logic for all config-like tables.
 *
 * Reads `type_config.validation` (JSONB-text parsed) and applies rules against
 * the raw string value. This is a pure function with zero DB dependencies,
 * designed for reuse across BE routers, microservice endpoints, and tests.
 *
 * The FE has its own JSON-to-Zod builder that reads the same `type_config.validation`
 * shape — the rule definitions and error keys are shared via the SDK types.
 */
import type { ConfigType, ConfigValidation } from "./iconfig-entity.js";

/**
 * Error thrown when a config value fails validation.
 * The `error_label_key` is an i18n translation key — the caller (BE router)
 * passes it to the FE, which translates it using the current locale.
 */
export class ConfigValidationError extends Error {
  /** i18n translation key for the error message (e.g. "config.auth.x.errors.min"). */
  readonly error_label_key: string;
  /** Which rule failed (min, max, url, email, regex, required, type). */
  readonly rule: string;
  /** The config key that failed validation (for context). */
  readonly config_key: string;

  constructor(
    error_label_key: string,
    rule: string,
    config_key: string,
    message?: string,
  ) {
    super(message ?? error_label_key);
    this.name = "ConfigValidationError";
    this.error_label_key = error_label_key;
    this.rule = rule;
    this.config_key = config_key;
  }
}

/**
 * Parse type_config JSON string into an object, returning null if invalid or empty.
 */
function parseTypeConfig(type_config: string | null | undefined): Record<string, unknown> | null {
  if (!type_config) return null;
  try {
    return JSON.parse(type_config) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract the validation config from a parsed type_config object.
 */
function extractValidation(parsed: Record<string, unknown> | null): ConfigValidation | null {
  if (!parsed || typeof parsed !== "object") return null;
  const validation = (parsed as Record<string, unknown>).validation;
  if (!validation || typeof validation !== "object") return null;
  return validation as unknown as ConfigValidation;
}

/**
 * Basic email regex — RFC 5322 simplified. Sufficient for config-level validation.
 * The FE uses Zod's `.email()` which has its own validation; this is the BE equivalent.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a config value against its type and type_config.validation rules.
 *
 * @param type       ConfigType of the row (string, integer, url, secret, etc.)
 * @param type_config Raw type_config JSON string from the DB row
 * @param value      The raw string value to validate
 * @param config_key The config key (for error context)
 * @throws {ConfigValidationError} if validation fails
 */
export function validateConfigValue(
  type: ConfigType,
  type_config: string | null | undefined,
  value: string,
  config_key: string,
): void {
  // 1. Parse type_config first so we can pass unsigned flag to validateType
  const parsed = parseTypeConfig(type_config);
  const validation = extractValidation(parsed);
  const unsigned = validation?.unsigned === true;

  // 2. Base type validation (unsigned-aware regex for numeric types)
  validateType(type, value, config_key, unsigned);

  // 3. If no validation config, we're done
  if (!validation) return;

  // 4. Required check — secrets with empty value are skipped (empty = "leave unchanged")
  if (validation.required && value === "" && type !== "secret") {
    throw new ConfigValidationError(
      validation.required_error_label_key ?? "validation.required",
      "required",
      config_key,
    );
  }

  const rules = validation.rules;
  if (!rules) return;

  // 5. Unsigned check — reject sign characters for unsigned numeric types
  //    (validateType already enforced the regex, but we re-check here in case
  //    the value passed validateType via a loose path; this is the authoritative
  //    business-rule enforcement point.)
  if (validation.unsigned && (type === "bigint" || type === "number" || type === "money")) {
    if (value.startsWith("-") || value.startsWith("+")) {
      throw new ConfigValidationError("validation.unsigned", "unsigned", config_key);
    }
  }

  // 6. min/max — for strings: length; for bigint: BigInt comparison; for number/money: numeric value
  //    For unsigned numeric types without an explicit min, default min to 0.
  const isUnsignedNumeric =
    validation.unsigned === true && (type === "bigint" || type === "number" || type === "money");

  if (rules.min) {
    if (type === "bigint") {
      const num = BigInt(value);
      const minVal = typeof rules.min.value === "bigint" ? rules.min.value : BigInt(rules.min.value);
      if (num < minVal) {
        throw new ConfigValidationError(rules.min.error_label_key, "min", config_key);
      }
    } else if (type === "number" || type === "money") {
      const num = Number(value);
      if (isNaN(num) || num < Number(rules.min.value)) {
        throw new ConfigValidationError(rules.min.error_label_key, "min", config_key);
      }
    } else if (type === "string" || type === "text" || type === "secret" || type === "url") {
      if (value.length < Number(rules.min.value)) {
        throw new ConfigValidationError(rules.min.error_label_key, "min", config_key);
      }
    }
  } else if (isUnsignedNumeric && value !== "") {
    // No explicit min rule, but unsigned → enforce min=0
    if (type === "bigint") {
      if (BigInt(value) < 0n) {
        throw new ConfigValidationError("validation.unsigned", "min", config_key);
      }
    } else {
      const num = Number(value);
      if (!isNaN(num) && num < 0) {
        throw new ConfigValidationError("validation.unsigned", "min", config_key);
      }
    }
  }

  if (rules.max) {
    if (type === "bigint") {
      const num = BigInt(value);
      const maxVal = typeof rules.max.value === "bigint" ? rules.max.value : BigInt(rules.max.value);
      if (num > maxVal) {
        throw new ConfigValidationError(rules.max.error_label_key, "max", config_key);
      }
    } else if (type === "number" || type === "money") {
      const num = Number(value);
      if (isNaN(num) || num > Number(rules.max.value)) {
        throw new ConfigValidationError(rules.max.error_label_key, "max", config_key);
      }
    } else if (type === "string" || type === "text" || type === "secret" || type === "url") {
      if (value.length > Number(rules.max.value)) {
        throw new ConfigValidationError(rules.max.error_label_key, "max", config_key);
      }
    }
  }

  // 7. URL protocol validation
  if (rules.url && (type === "url" || type === "string")) {
    try {
      const url = new URL(value);
      const protocol = url.protocol.replace(/:$/, "");
      if (!rules.url.protocols.includes(protocol)) {
        throw new ConfigValidationError(rules.url.error_label_key, "url", config_key);
      }
    } catch (e) {
      if (e instanceof ConfigValidationError) throw e;
      throw new ConfigValidationError(rules.url.error_label_key, "url", config_key);
    }
  }

  // 8. Email validation
  if (rules.email && (type === "string" || type === "text")) {
    if (!EMAIL_REGEX.test(value)) {
      throw new ConfigValidationError(rules.email.error_label_key, "email", config_key);
    }
  }

  // 9. Regex validation
  if (rules.regex && (type === "string" || type === "text" || type === "secret")) {
    try {
      const regex = new RegExp(rules.regex.pattern);
      if (!regex.test(value)) {
        throw new ConfigValidationError(rules.regex.error_label_key, "regex", config_key);
      }
    } catch (e) {
      if (e instanceof ConfigValidationError) throw e;
      // Invalid regex pattern in config — treat as validation failure
      throw new ConfigValidationError(rules.regex.error_label_key, "regex", config_key);
    }
  }
}

/**
 * Base type validation — checks the value matches the declared ConfigType.
 * This is the type-level check that runs before validation rules.
 * @param unsigned If true, sign characters are rejected for numeric types.
 */
function validateType(type: ConfigType, value: string, config_key: string, unsigned: boolean = false): void {
  switch (type) {
    case "boolean":
      if (value !== "true" && value !== "false") {
        throw new ConfigValidationError("validation.invalidBoolean", "type", config_key);
      }
      break;
    case "bigint":
      if (unsigned) {
        if (!/^\d+$/.test(value)) {
          throw new ConfigValidationError("validation.invalidBigintUnsigned", "type", config_key);
        }
      } else {
        if (!/^-?\d+$/.test(value)) {
          throw new ConfigValidationError("validation.invalidBigint", "type", config_key);
        }
      }
      break;
    case "number":
    case "money":
      if (isNaN(Number(value))) {
        throw new ConfigValidationError("validation.invalidNumber", "type", config_key);
      }
      if (unsigned && (value.startsWith("-") || value.startsWith("+"))) {
        throw new ConfigValidationError("validation.invalidNumberUnsigned", "type", config_key);
      }
      break;
    case "url":
      try {
        new URL(value);
      } catch {
        throw new ConfigValidationError("validation.invalidUrl", "type", config_key);
      }
      break;
    case "json":
      try {
        JSON.parse(value);
      } catch {
        throw new ConfigValidationError("validation.invalidJson", "type", config_key);
      }
      break;
    // string, text, secret, badge, list, date, datetime, time: no base type check
    // badge/list values are validated against type_config.values/api_url separately
  }
}

/**
 * Coerce a raw string config value to its native JS type.
 * Returns the typed value for BE→FE response shaping.
 * - bigint → native bigint
 * - number → native number
 * - money → native number (amount only; currency is in type_config, not in the value)
 * - all others → string as-is
 */
export function coerceConfigValue(
  type: ConfigType,
  value: string | null,
  type_config?: string | null,
): string | number | bigint | null {
  if (value === null) return null;
  switch (type) {
    case "bigint":
      return BigInt(value);
    case "number":
    case "money":
      return Number(value);
    default:
      return value;
  }
}

/**
 * Serialize a typed value back to string for DB storage.
 * - bigint → String(value)
 * - number → String(value)
 * - string → value
 */
export function serializeConfigValue(
  type: ConfigType,
  value: string | number | bigint,
): string {
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") return String(value);
  return value;
}
