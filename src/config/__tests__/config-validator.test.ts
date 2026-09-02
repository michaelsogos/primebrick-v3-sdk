import { describe, it, expect } from "vitest";
import { validateConfigValue, ConfigValidationError } from "../config-validator.js";

describe("validateConfigValue", () => {
  // ─── Base type validation ───────────────────────────────────────────────

  it("rejects non-boolean for boolean type", () => {
    expect(() => validateConfigValue("boolean", null, "yes", "test_key")).toThrow(ConfigValidationError);
    expect(() => validateConfigValue("boolean", null, "yes", "test_key")).toThrow(/invalidBoolean/);
  });

  it("accepts 'true' and 'false' for boolean type", () => {
    expect(() => validateConfigValue("boolean", null, "true", "test_key")).not.toThrow();
    expect(() => validateConfigValue("boolean", null, "false", "test_key")).not.toThrow();
  });

  it("rejects non-bigint for bigint type", () => {
    expect(() => validateConfigValue("bigint", null, "abc", "test_key")).toThrow(/invalidBigint/);
    expect(() => validateConfigValue("bigint", null, "1.5", "test_key")).toThrow(/invalidBigint/);
  });

  it("accepts valid bigints", () => {
    expect(() => validateConfigValue("bigint", null, "30", "test_key")).not.toThrow();
    expect(() => validateConfigValue("bigint", null, "-5", "test_key")).not.toThrow();
  });

  it("rejects non-number for money type", () => {
    expect(() => validateConfigValue("money", null, "abc", "test_key")).toThrow(/invalidNumber/);
  });

  it("accepts valid money amounts", () => {
    expect(() => validateConfigValue("money", null, "99.99", "test_key")).not.toThrow();
    expect(() => validateConfigValue("money", null, "0", "test_key")).not.toThrow();
  });

  it("rejects non-number for number type", () => {
    expect(() => validateConfigValue("number", null, "abc", "test_key")).toThrow(/invalidNumber/);
  });

  it("rejects invalid URL for url type", () => {
    expect(() => validateConfigValue("url", null, "not-a-url", "test_key")).toThrow(/invalidUrl/);
  });

  it("rejects invalid JSON for json type", () => {
    expect(() => validateConfigValue("json", null, "{invalid", "test_key")).toThrow(/invalidJson/);
  });

  it("accepts valid JSON", () => {
    expect(() => validateConfigValue("json", null, '{"key":"value"}', "test_key")).not.toThrow();
  });

  // ─── Required rule ──────────────────────────────────────────────────────

  it("rejects empty string when required=true", () => {
    const tc = JSON.stringify({ validation: { required: true, rules: {} } });
    expect(() => validateConfigValue("string", tc, "", "test_key")).toThrow(/validation\.required/);
  });

  it("allows empty string when required=false", () => {
    const tc = JSON.stringify({ validation: { required: false, rules: {} } });
    expect(() => validateConfigValue("string", tc, "", "test_key")).not.toThrow();
  });

  it("skips required check for secrets with empty value (leave unchanged)", () => {
    const tc = JSON.stringify({ validation: { required: true, rules: {} } });
    expect(() => validateConfigValue("secret", tc, "", "test_key")).not.toThrow();
  });

  // ─── min/max rules ──────────────────────────────────────────────────────

  it("validates min for bigint (numeric value)", () => {
    const tc = JSON.stringify({
      validation: { required: true, rules: { min: { value: 1, error_label_key: "err.min" } } },
    });
    expect(() => validateConfigValue("bigint", tc, "0", "test_key")).toThrow(/err\.min/);
    expect(() => validateConfigValue("bigint", tc, "1", "test_key")).not.toThrow();
    expect(() => validateConfigValue("bigint", tc, "90", "test_key")).not.toThrow();
  });

  it("validates max for bigint (numeric value)", () => {
    const tc = JSON.stringify({
      validation: { required: true, rules: { max: { value: 90, error_label_key: "err.max" } } },
    });
    expect(() => validateConfigValue("bigint", tc, "91", "test_key")).toThrow(/err\.max/);
    expect(() => validateConfigValue("bigint", tc, "90", "test_key")).not.toThrow();
  });

  it("validates min for money (numeric value)", () => {
    const tc = JSON.stringify({
      validation: { required: true, rules: { min: { value: 0, error_label_key: "err.min" } } },
    });
    expect(() => validateConfigValue("money", tc, "-1", "test_key")).toThrow(/err\.min/);
    expect(() => validateConfigValue("money", tc, "0", "test_key")).not.toThrow();
  });

  it("validates min for string (length)", () => {
    const tc = JSON.stringify({
      validation: { required: true, rules: { min: { value: 6, error_label_key: "err.min" } } },
    });
    expect(() => validateConfigValue("string", tc, "abc", "test_key")).toThrow(/err\.min/);
    expect(() => validateConfigValue("string", tc, "abcdef", "test_key")).not.toThrow();
  });

  it("validates max for string (length)", () => {
    const tc = JSON.stringify({
      validation: { required: true, rules: { max: { value: 100, error_label_key: "err.max" } } },
    });
    expect(() => validateConfigValue("string", tc, "a".repeat(101), "test_key")).toThrow(/err\.max/);
    expect(() => validateConfigValue("string", tc, "a".repeat(100), "test_key")).not.toThrow();
  });

  it("validates min for secret (length)", () => {
    const tc = JSON.stringify({
      validation: { required: true, rules: { min: { value: 32, error_label_key: "err.min" } } },
    });
    expect(() => validateConfigValue("secret", tc, "short", "test_key")).toThrow(/err\.min/);
    expect(() => validateConfigValue("secret", tc, "x".repeat(32), "test_key")).not.toThrow();
  });

  // ─── URL protocol validation ────────────────────────────────────────────

  it("validates URL protocols", () => {
    const tc = JSON.stringify({
      validation: {
        required: true,
        rules: {
          url: { protocols: ["http", "https", "redis", "rediss", "tcp"], error_label_key: "err.url" },
        },
      },
    });
    expect(() => validateConfigValue("url", tc, "redis://localhost:6379", "test_key")).not.toThrow();
    expect(() => validateConfigValue("url", tc, "https://example.com", "test_key")).not.toThrow();
    expect(() => validateConfigValue("url", tc, "ftp://example.com", "test_key")).toThrow(/err\.url/);
  });

  it("rejects malformed URL in protocol validation (base type catches first)", () => {
    const tc = JSON.stringify({
      validation: {
        required: true,
        rules: {
          url: { protocols: ["https"], error_label_key: "err.url" },
        },
      },
    });
    // Base type validation runs first and throws validation.invalidUrl
    expect(() => validateConfigValue("url", tc, "not-a-url", "test_key")).toThrow(/invalidUrl/);
  });

  // ─── Email validation ───────────────────────────────────────────────────

  it("validates email format", () => {
    const tc = JSON.stringify({
      validation: {
        required: true,
        rules: { email: { error_label_key: "err.email" } },
      },
    });
    expect(() => validateConfigValue("string", tc, "admin@example.com", "test_key")).not.toThrow();
    expect(() => validateConfigValue("string", tc, "not-an-email", "test_key")).toThrow(/err\.email/);
    expect(() => validateConfigValue("string", tc, "missing@domain", "test_key")).toThrow(/err\.email/);
  });

  // ─── Regex validation ───────────────────────────────────────────────────

  it("validates regex pattern", () => {
    const tc = JSON.stringify({
      validation: {
        required: true,
        rules: { regex: { pattern: "^[a-zA-Z0-9._-]+$", error_label_key: "err.regex" } },
      },
    });
    expect(() => validateConfigValue("string", tc, "roles.path", "test_key")).not.toThrow();
    expect(() => validateConfigValue("string", tc, "roles path", "test_key")).toThrow(/err\.regex/);
  });

  // ─── Combined rules ─────────────────────────────────────────────────────

  it("validates combined min + max for bigint", () => {
    const tc = JSON.stringify({
      validation: {
        required: true,
        rules: {
          min: { value: 30, error_label_key: "err.min" },
          max: { value: 600, error_label_key: "err.max" },
        },
      },
    });
    expect(() => validateConfigValue("bigint", tc, "29", "test_key")).toThrow(/err\.min/);
    expect(() => validateConfigValue("bigint", tc, "601", "test_key")).toThrow(/err\.max/);
    expect(() => validateConfigValue("bigint", tc, "300", "test_key")).not.toThrow();
  });

  it("validates combined min + max + url for url type", () => {
    const tc = JSON.stringify({
      validation: {
        required: true,
        rules: {
          min: { value: 10, error_label_key: "err.min" },
          max: { value: 500, error_label_key: "err.max" },
          url: { protocols: ["http", "https"], error_label_key: "err.url" },
        },
      },
    });
    expect(() => validateConfigValue("url", tc, "https://example.com/path", "test_key")).not.toThrow();
    expect(() => validateConfigValue("url", tc, "ftp://x.com", "test_key")).toThrow(/err\.url/);
    expect(() => validateConfigValue("url", tc, "https://x", "test_key")).toThrow(/err\.min/);
  });

  // ─── unsigned flag ──────────────────────────────────────────────────────

  it("unsigned bigint rejects negative sign", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    expect(() => validateConfigValue("bigint", tc, "-5", "test_key")).toThrow();
    expect(() => validateConfigValue("bigint", tc, "5", "test_key")).not.toThrow();
  });

  it("unsigned bigint rejects plus sign", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    expect(() => validateConfigValue("bigint", tc, "+5", "test_key")).toThrow();
  });

  it("unsigned bigint accepts zero", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    expect(() => validateConfigValue("bigint", tc, "0", "test_key")).not.toThrow();
  });

  it("unsigned bigint defaults min to 0 when no explicit min rule", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    // Negative values are already rejected by the regex, but the default-min=0
    // also guards against edge cases where the value passes the regex but is < 0.
    expect(() => validateConfigValue("bigint", tc, "0", "test_key")).not.toThrow();
    expect(() => validateConfigValue("bigint", tc, "42", "test_key")).not.toThrow();
  });

  it("unsigned bigint respects explicit min rule over default 0", () => {
    const tc = JSON.stringify({
      validation: { unsigned: true, required: true, rules: { min: { value: 10, error_label_key: "err.min" } } },
    });
    expect(() => validateConfigValue("bigint", tc, "5", "test_key")).toThrow(/err\.min/);
    expect(() => validateConfigValue("bigint", tc, "10", "test_key")).not.toThrow();
  });

  it("unsigned number rejects negative sign", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    expect(() => validateConfigValue("number", tc, "-3.14", "test_key")).toThrow();
    expect(() => validateConfigValue("number", tc, "3.14", "test_key")).not.toThrow();
  });

  it("unsigned number rejects plus sign", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    expect(() => validateConfigValue("number", tc, "+3.14", "test_key")).toThrow();
  });

  it("unsigned money rejects negative sign", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    expect(() => validateConfigValue("money", tc, "-99.99", "test_key")).toThrow();
    expect(() => validateConfigValue("money", tc, "99.99", "test_key")).not.toThrow();
  });

  it("unsigned money defaults min to 0 when no explicit min rule", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    expect(() => validateConfigValue("money", tc, "0", "test_key")).not.toThrow();
    expect(() => validateConfigValue("money", tc, "0.01", "test_key")).not.toThrow();
  });

  it("unsigned: false is the same as absent (signed, default)", () => {
    const tc = JSON.stringify({ validation: { unsigned: false, required: true, rules: {} } });
    expect(() => validateConfigValue("bigint", tc, "-5", "test_key")).not.toThrow();
  });

  it("unsigned flag absent is signed (default, backward compatible)", () => {
    const tc = JSON.stringify({ validation: { required: true, rules: {} } });
    expect(() => validateConfigValue("bigint", tc, "-5", "test_key")).not.toThrow();
    expect(() => validateConfigValue("number", tc, "-3.14", "test_key")).not.toThrow();
  });

  it("unsigned flag only affects numeric types (not string)", () => {
    const tc = JSON.stringify({ validation: { unsigned: true, required: true, rules: {} } });
    // String values are not affected by unsigned — it's a no-op for non-numeric types
    expect(() => validateConfigValue("string", tc, "-hello-", "test_key")).not.toThrow();
  });

  // ─── No validation rules ────────────────────────────────────────────────

  it("passes when type_config has no validation key", () => {
    const tc = JSON.stringify({ values: { a: { label_key: "lbl" } } });
    expect(() => validateConfigValue("badge", tc, "a", "test_key")).not.toThrow();
  });

  it("passes when type_config is null", () => {
    expect(() => validateConfigValue("string", null, "any value", "test_key")).not.toThrow();
  });

  it("passes when type_config is invalid JSON", () => {
    expect(() => validateConfigValue("string", "{invalid", "any value", "test_key")).not.toThrow();
  });

  // ─── Error properties ───────────────────────────────────────────────────

  it("ConfigValidationError has correct properties", () => {
    const tc = JSON.stringify({
      validation: { required: true, rules: { min: { value: 6, error_label_key: "custom.error.key" } } },
    });
    try {
      validateConfigValue("string", tc, "abc", "my_config_key");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.error_label_key).toBe("custom.error.key");
      expect(err.rule).toBe("min");
      expect(err.config_key).toBe("my_config_key");
    }
  });
});
