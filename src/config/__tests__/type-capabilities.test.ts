import { describe, expect, it } from "vitest";
import {
  NUMERIC_TYPES,
  STRING_DERIVED_TYPES,
  TYPE_CAPABILITIES,
  typeCapabilities,
} from "../type-capabilities.js";
import type { ConfigType } from "../iconfig-entity.js";

const ALL_TYPES: ConfigType[] = [
  "string", "text", "boolean", "bigint", "number", "money", "badge",
  "single_select", "multi_select", "url", "secret", "json", "date",
  "datetime", "time", "email", "phone",
];

describe("TYPE_CAPABILITIES", () => {
  it("covers every ConfigType", () => {
    for (const t of ALL_TYPES) {
      expect(TYPE_CAPABILITIES[t], `missing capabilities for ${t}`).toBeDefined();
      expect(TYPE_CAPABILITIES[t].validation.required).toBe(true);
    }
    expect(Object.keys(TYPE_CAPABILITIES).sort()).toEqual([...ALL_TYPES].sort());
  });

  it("string-derived types have length bounds and regex", () => {
    for (const t of STRING_DERIVED_TYPES) {
      const caps = TYPE_CAPABILITIES[t];
      expect(caps.validation.min).toBe("length");
      expect(caps.validation.max).toBe("length");
      expect(caps.validation.regex).toBe(true);
      expect(caps.validation.unsigned).toBe(false);
    }
  });

  it("numeric types have value bounds and unsigned", () => {
    for (const t of NUMERIC_TYPES) {
      const caps = TYPE_CAPABILITIES[t];
      expect(caps.validation.min).toBe("value");
      expect(caps.validation.max).toBe("value");
      expect(caps.validation.unsigned).toBe(true);
      expect(caps.validation.regex).toBe(false);
    }
  });

  it("types without bounds have no min/max capability", () => {
    for (const t of ["boolean", "json", "date", "datetime", "time", "badge", "single_select", "multi_select"] as const) {
      expect(TYPE_CAPABILITIES[t].validation.min).toBeUndefined();
      expect(TYPE_CAPABILITIES[t].validation.max).toBeUndefined();
      expect(TYPE_CAPABILITIES[t].validation.regex).toBe(false);
      expect(TYPE_CAPABILITIES[t].validation.unsigned).toBe(false);
    }
  });

  it("widget capabilities match per-type type_config props", () => {
    expect(TYPE_CAPABILITIES.money.widget.currency).toBe(true);
    expect(TYPE_CAPABILITIES.phone.widget.country).toBe(true);
    expect(TYPE_CAPABILITIES.badge.widget.badge_values).toBe(true);
    expect(TYPE_CAPABILITIES.single_select.widget.select_source).toBe(true);
    expect(TYPE_CAPABILITIES.multi_select.widget.select_source).toBe(true);
    expect(TYPE_CAPABILITIES.url.widget.url_protocols).toBe(true);
    expect(TYPE_CAPABILITIES.string.widget).toEqual({});
  });

  it("typeCapabilities accessor returns the same record", () => {
    expect(typeCapabilities("money")).toBe(TYPE_CAPABILITIES.money);
  });
});
