/**
 * Config value validator — shared validation logic for all config-like tables.
 *
 * Reads `type_config.validation` (JSONB-text parsed) and applies rules against
 * the raw string value. This is a pure function with zero DB dependencies,
 * designed for reuse across BE routers, microservice endpoints, and tests.
 *
 * The FE has its own JSON-to-Zod builder that reads the same `type_config.validation`
 * shape — the rule definitions and error keys are shared via the SDK types.
 *
 * All error keys use the `app.common.validation.*` prefix, matching the BE DB
 * seed translations and the FE fallback. Both FE and BE use the same keys.
 */
import type { ConfigType, ConfigValidation } from "./iconfig-entity.js";
import { parsePhoneNumber } from "libphonenumber-js";

/**
 * Error thrown when a config value fails validation.
 * The `error_label_key` is an i18n translation key — the caller (BE router)
 * passes it to the FE, which translates it using the current locale.
 */
export class ConfigValidationError extends Error {
  /** i18n translation key for the error message (e.g. "app.common.validation.invalidBigint"). */
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
 * Used by both SDK (validateType for `email` type) and FE (Zod refine).
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
  // 1. Parse type_config first so we can pass unsigned flag and type_config to validateType
  const parsed = parseTypeConfig(type_config);
  const validation = extractValidation(parsed);
  const unsigned = validation?.unsigned === true;

  // 2. Base type validation (unsigned-aware regex for numeric types, type_config for url/phone)
  validateType(type, value, config_key, unsigned, type_config);

  // 3. If no validation config, we're done
  if (!validation) return;

  // 4. Required check — secrets with empty value are skipped (empty = "leave unchanged")
  if (validation.required && value === "" && type !== "secret") {
    throw new ConfigValidationError(
      validation.required_error_label_key ?? "app.common.validation.required",
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
      throw new ConfigValidationError("app.common.validation.unsigned", "unsigned", config_key);
    }
  }

  // 6. min/max — for strings: length; for bigint: BigInt comparison; for number/money: numeric value
  //    For unsigned numeric types without an explicit min, default min to 0.
  //    String-derived types: string, text, secret, url, email, phone
  const isUnsignedNumeric =
    validation.unsigned === true && (type === "bigint" || type === "number" || type === "money");

  const isStringDerived =
    type === "string" || type === "text" || type === "secret" || type === "url" ||
    type === "email" || type === "phone";

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
    } else if (isStringDerived) {
      if (value.length < Number(rules.min.value)) {
        throw new ConfigValidationError(rules.min.error_label_key, "min", config_key);
      }
    }
  } else if (isUnsignedNumeric && value !== "") {
    // No explicit min rule, but unsigned → enforce min=0
    if (type === "bigint") {
      if (BigInt(value) < 0n) {
        throw new ConfigValidationError("app.common.validation.unsigned", "min", config_key);
      }
    } else {
      const num = Number(value);
      if (!isNaN(num) && num < 0) {
        throw new ConfigValidationError("app.common.validation.unsigned", "min", config_key);
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
    } else if (isStringDerived) {
      if (value.length > Number(rules.max.value)) {
        throw new ConfigValidationError(rules.max.error_label_key, "max", config_key);
      }
    }
  }

  // 7. URL protocol validation (deprecated — use type_config.allowed_protocols instead)
  //    Still validated for type === "url" for backward compatibility.
  if (rules.url && type === "url") {
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

  // 8. Email validation (deprecated — use TYPE "email" instead)
  //    Still validated for type === "email" for backward compatibility.
  if (rules.email && type === "email") {
    if (!EMAIL_REGEX.test(value)) {
      throw new ConfigValidationError(rules.email.error_label_key, "email", config_key);
    }
  }

  // 9. Regex validation — applies to string-derived types
  //    Invalid regex pattern is a configuration error: throw in both FE and BE.
  //    Invalid pattern errors ALWAYS use invalidRegexPattern (not the custom rule key).
  //    Mismatch errors use the custom rule key, falling back to regexMismatch.
  if (rules.regex && isStringDerived) {
    let regex: RegExp;
    try {
      regex = new RegExp(rules.regex.pattern, rules.regex.flags ?? "");
    } catch {
      // Invalid regex pattern in config — configuration error, must fail consistently.
      // Always use the invalid-pattern key, even if a custom regex error key is configured.
      throw new ConfigValidationError(
        "app.common.validation.invalidRegexPattern",
        "regex",
        config_key,
      );
    }
    if (!regex.test(value)) {
      throw new ConfigValidationError(
        rules.regex.error_label_key ?? "app.common.validation.regexMismatch",
        "regex",
        config_key,
      );
    }
  }
}

/**
 * Base type validation — checks the value matches the declared ConfigType.
 * This is the type-level check that runs before validation rules.
 * @param unsigned If true, sign characters are rejected for numeric types.
 * @param type_config Raw type_config JSON string (needed for url allowed_protocols and phone country).
 */
function validateType(
  type: ConfigType,
  value: string,
  config_key: string,
  unsigned: boolean = false,
  type_config?: string | null,
): void {
  switch (type) {
    case "boolean":
      if (value !== "true" && value !== "false") {
        throw new ConfigValidationError("app.common.validation.invalidBoolean", "type", config_key);
      }
      break;
    case "bigint":
      if (unsigned) {
        if (!/^\d+$/.test(value)) {
          throw new ConfigValidationError("app.common.validation.invalidBigintUnsigned", "type", config_key);
        }
      } else {
        if (!/^-?\d+$/.test(value)) {
          throw new ConfigValidationError("app.common.validation.invalidBigint", "type", config_key);
        }
      }
      break;
    case "number":
    case "money": {
      // Use regex (same as FE) instead of isNaN(Number(value)) for congruence.
      // Regex is stricter: rejects "1e5", "Infinity", "  5  " which Number() accepts.
      const numRegex = unsigned ? /^\d*\.?\d+$/ : /^-?\d*\.?\d+$/;
      if (!numRegex.test(value)) {
        throw new ConfigValidationError(
          unsigned ? "app.common.validation.invalidNumberUnsigned" : "app.common.validation.invalidNumber",
          "type",
          config_key,
        );
      }
      break;
    }
    case "url": {
      try {
        const url = new URL(value);
        // Check allowed_protocols from type_config
        const parsed = parseTypeConfig(type_config);
        const allowedProtocols = parsed?.allowed_protocols as string[] | undefined;
        if (allowedProtocols && allowedProtocols.length > 0) {
          const protocol = url.protocol.replace(/:$/, "");
          if (!allowedProtocols.includes(protocol)) {
            throw new ConfigValidationError("app.common.validation.invalidUrlProtocol", "type", config_key);
          }
        }
      } catch (e) {
        if (e instanceof ConfigValidationError) throw e;
        throw new ConfigValidationError("app.common.validation.invalidUrl", "type", config_key);
      }
      break;
    }
    case "email":
      if (value && !EMAIL_REGEX.test(value)) {
        throw new ConfigValidationError("app.common.validation.invalidEmail", "type", config_key);
      }
      break;
    case "phone": {
      // Skip empty values — required check is handled by validateConfigValue.
      if (!value) break;
      // Full validation via libphonenumber-js — same library used by FE.
      // Country from type_config.country enables country-specific validation.
      const parsed = parseTypeConfig(type_config);
      const country = parsed?.country as string | undefined;
      try {
        const phoneNumber = country
          ? parsePhoneNumber(value, country as any)
          : parsePhoneNumber(value);
        if (!phoneNumber || !phoneNumber.isValid()) {
          throw new ConfigValidationError("app.common.validation.invalidPhone", "type", config_key);
        }
      } catch (e) {
        if (e instanceof ConfigValidationError) throw e;
        throw new ConfigValidationError("app.common.validation.invalidPhone", "type", config_key);
      }
      break;
    }
    case "json":
      try {
        JSON.parse(value);
      } catch {
        throw new ConfigValidationError("app.common.validation.invalidJson", "type", config_key);
      }
      break;
    // string, text, secret, badge, single_select, multi_select, date, datetime, time: no base type check
    // badge/single_select/multi_select values are validated against type_config.values/api_url/values_source separately
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
