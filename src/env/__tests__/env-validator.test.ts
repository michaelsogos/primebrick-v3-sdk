import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv, requireEnv } from "../env-validator.js";

describe("validateEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns valid:true when all required env vars are present", () => {
    process.env.FOO = "bar";
    const result = validateEnv({ FOO: { required: true } });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.env.FOO).toBe("bar");
  });

  it("returns valid:false when a required env var is missing", () => {
    delete process.env.MISSING;
    const result = validateEnv({ MISSING: { required: true, description: "needed for X" } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("MISSING is required");
    expect(result.errors[0]).toContain("needed for X");
  });

  it("returns valid:false when a required env var is empty string", () => {
    process.env.EMPTY = "";
    const result = validateEnv({ EMPTY: { required: true } });
    expect(result.valid).toBe(false);
  });

  it("applies default when env var is missing", () => {
    delete process.env.PORT;
    const result = validateEnv({ PORT: { required: false, default: "8080" } });
    expect(result.valid).toBe(true);
    expect(result.env.PORT).toBe("8080");
  });

  it("does not apply default when env var is set", () => {
    process.env.PORT = "9090";
    const result = validateEnv({ PORT: { required: false, default: "8080" } });
    expect(result.env.PORT).toBe("9090");
  });

  it("optional vars without default stay undefined when missing", () => {
    delete process.env.OPT;
    const result = validateEnv({ OPT: { required: false } });
    expect(result.env.OPT).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});

describe("requireEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns env when valid", () => {
    process.env.X = "1";
    const env = requireEnv({ X: { required: true } });
    expect(env.X).toBe("1");
  });

  it("throws with all errors when invalid", () => {
    delete process.env.A;
    delete process.env.B;
    expect(() => requireEnv({
      A: { required: true },
      B: { required: true, description: "for B" },
    })).toThrow(/Environment validation failed/);
  });
});
