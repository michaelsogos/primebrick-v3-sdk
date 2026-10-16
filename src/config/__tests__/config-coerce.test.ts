import { describe, it, expect } from "vitest";
import { coerceConfigValue, serializeConfigValue } from "../config-validator.js";

describe("coerceConfigValue", () => {
  it("coerces bigint string to native bigint", () => {
    expect(coerceConfigValue("bigint", "42")).toBe(42n);
    expect(typeof coerceConfigValue("bigint", "42")).toBe("bigint");
  });

  it("coerces negative bigint string to native bigint", () => {
    expect(coerceConfigValue("bigint", "-5")).toBe(-5n);
  });

  it("coerces very large bigint string preserving precision", () => {
    expect(coerceConfigValue("bigint", "99999999999999999999")).toBe(99999999999999999999n);
  });

  it("returns null for null bigint value", () => {
    expect(coerceConfigValue("bigint", null)).toBeNull();
  });

  it("coerces number string to native number", () => {
    expect(coerceConfigValue("number", "3.14")).toBe(3.14);
    expect(typeof coerceConfigValue("number", "3.14")).toBe("number");
  });

  it("returns null for null number value", () => {
    expect(coerceConfigValue("number", null)).toBeNull();
  });

  it("coerces money string to native number (amount only)", () => {
    expect(coerceConfigValue("money", "1234.56", '{"currency":"EUR"}')).toBe(1234.56);
    expect(typeof coerceConfigValue("money", "1234.56", '{"currency":"EUR"}')).toBe("number");
  });

  it("coerces money zero to number 0", () => {
    expect(coerceConfigValue("money", "0", '{"currency":"JPY"}')).toBe(0);
  });

  it("returns null for null money value", () => {
    expect(coerceConfigValue("money", null)).toBeNull();
  });

  it("coerces money without type_config", () => {
    expect(coerceConfigValue("money", "100", null)).toBe(100);
  });

  it("returns string as-is for string type", () => {
    expect(coerceConfigValue("string", "hello")).toBe("hello");
  });

  it("returns string as-is for boolean type (BE config-repo handles boolean)", () => {
    expect(coerceConfigValue("boolean", "true")).toBe("true");
  });

  it("returns string as-is for secret type", () => {
    expect(coerceConfigValue("secret", "my-secret-key")).toBe("my-secret-key");
  });
});

describe("serializeConfigValue", () => {
  it("serializes bigint to string", () => {
    expect(serializeConfigValue("bigint", 42n)).toBe("42");
  });

  it("serializes negative bigint to string", () => {
    expect(serializeConfigValue("bigint", -5n)).toBe("-5");
  });

  it("serializes very large bigint to string preserving precision", () => {
    expect(serializeConfigValue("bigint", 99999999999999999999n)).toBe("99999999999999999999");
  });

  it("serializes number to string", () => {
    expect(serializeConfigValue("number", 3.14)).toBe("3.14");
  });

  it("serializes money amount to string", () => {
    expect(serializeConfigValue("money", 99.99)).toBe("99.99");
  });

  it("serializes string as-is", () => {
    expect(serializeConfigValue("string", "hello")).toBe("hello");
  });

  it("round-trips bigint through coerce then serialize", () => {
    const coerced = coerceConfigValue("bigint", "99999999999999999999");
    expect(typeof coerced).toBe("bigint");
    const serialized = serializeConfigValue("bigint", coerced as bigint);
    expect(serialized).toBe("99999999999999999999");
  });

  it("round-trips number through coerce then serialize", () => {
    const coerced = coerceConfigValue("number", "3.14");
    expect(typeof coerced).toBe("number");
    const serialized = serializeConfigValue("number", coerced as number);
    expect(serialized).toBe("3.14");
  });

  it("round-trips money through coerce then serialize", () => {
    const coerced = coerceConfigValue("money", "1234.56", '{"currency":"EUR"}');
    expect(typeof coerced).toBe("number");
    const serialized = serializeConfigValue("money", coerced as number);
    expect(serialized).toBe("1234.56");
  });
});
