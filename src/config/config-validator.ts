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
  // 1. Base type validation (same as before, but now in the SDK)
  validateType(type, value, config_key);

  // 2. Validation rules from type_config.validation
  const parsed = parseTypeConfig(type_config);
  const validation = extractValidation(parsed);
  if (!validation) return;

  // 3. Required check — all types including secrets
  if (validation.required && value === "") {
    throw new ConfigValidationError(
      validation.required_error_label_key ?? "validation.required",
      "required",
      config_key,
    );
  }

  const rules = validation.rules;
  if (!rules) return;

  // 4. min/max — for strings: length; for integer/number: numeric value
  if (rules.min) {
    if (type === "integer" || type === "number") {
      const num = Number(value);
      if (isNaN(num) || num < rules.min.value) {
        throw new ConfigValidationError(rules.min.error_label_key, "min", config_key);
      }
    } else if (type === "string" || type === "text" || type === "secret" || type === "url") {
      if (value.length < rules.min.value) {
        throw new ConfigValidationError(rules.min.error_label_key, "min", config_key);
      }
    }
  }

  if (rules.max) {
    if (type === "integer" || type === "number") {
      const num = Number(value);
      if (isNaN(num) || num > rules.max.value) {
        throw new ConfigValidationError(rules.max.error_label_key, "max", config_key);
      }
    } else if (type === "string" || type === "text" || type === "secret" || type === "url") {
      if (value.length > rules.max.value) {
        throw new ConfigValidationError(rules.max.error_label_key, "max", config_key);
      }
    }
  }

  // 5. URL protocol validation
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

  // 6. Email validation
  if (rules.email && (type === "string" || type === "text")) {
    if (!EMAIL_REGEX.test(value)) {
      throw new ConfigValidationError(rules.email.error_label_key, "email", config_key);
    }
  }

  // 7. Regex validation
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
 */
function validateType(type: ConfigType, value: string, config_key: string): void {
  switch (type) {
    case "boolean":
      if (value !== "true" && value !== "false") {
        throw new ConfigValidationError("validation.invalidBoolean", "type", config_key);
      }
      break;
    case "integer":
      if (!/^-?\d+$/.test(value)) {
        throw new ConfigValidationError("validation.invalidInteger", "type", config_key);
      }
      break;
    case "number":
      if (isNaN(Number(value))) {
        throw new ConfigValidationError("validation.invalidNumber", "type", config_key);
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
