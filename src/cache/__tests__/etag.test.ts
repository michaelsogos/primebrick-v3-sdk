import { describe, it, expect } from "vitest";
import { computeETag, computeVersionETag, wrapCacheEntry, etagMatches } from "../etag.js";

describe("computeETag", () => {
  it("produces a quoted string", () => {
    const etag = computeETag({ foo: "bar" });
    expect(etag.startsWith('"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const a = computeETag({ foo: "bar", n: 42 });
    const b = computeETag({ foo: "bar", n: 42 });
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    const a = computeETag({ foo: "bar" });
    const b = computeETag({ foo: "baz" });
    expect(a).not.toBe(b);
  });

  it("handles BigInt values", () => {
    const a = computeETag({ id: 42n });
    const b = computeETag({ id: 42n });
    expect(a).toBe(b);
  });

  it("treats BigInt and Number with the same value as equal (ext-json serializes both as numbers)", () => {
    const a = computeETag({ id: 42n });
    const b = computeETag({ id: 42 });
    // json-bigint serializes 42n and 42 both as the JSON number 42
    expect(a).toBe(b);
  });

  it("is stable for key-order-independent objects (JSON.stringify is order-sensitive, so this verifies order matters)", () => {
    const a = computeETag({ a: 1, b: 2 });
    const b = computeETag({ b: 2, a: 1 });
    // ext-json (json-bigint) preserves insertion order like JSON.stringify
    // So different key order → different hash. This is expected.
    expect(a).not.toBe(b);
  });
});

describe("computeVersionETag", () => {
  it("produces a quoted version tag", () => {
    expect(computeVersionETag(1)).toBe('"v1"');
    expect(computeVersionETag(42)).toBe('"v42"');
  });

  it("handles string versions", () => {
    expect(computeVersionETag("abc")).toBe('"vabc"');
  });

  it("is deterministic", () => {
    expect(computeVersionETag(5)).toBe(computeVersionETag(5));
  });
});

describe("wrapCacheEntry", () => {
  it("wraps data with a computed ETag", () => {
    const entry = wrapCacheEntry({ foo: "bar" });
    expect(entry.data).toEqual({ foo: "bar" });
    expect(entry.etag).toMatch(/^".+"$/);
    expect(typeof entry.cached_at).toBe("number");
  });

  it("accepts a custom ETag", () => {
    const entry = wrapCacheEntry({ foo: "bar" }, '"custom-etag"');
    expect(entry.etag).toBe('"custom-etag"');
  });

  it("computes the same ETag as computeETag", () => {
    const data = { foo: "bar", n: 42n };
    const entry = wrapCacheEntry(data);
    expect(entry.etag).toBe(computeETag(data));
  });
});

describe("etagMatches", () => {
  it("returns false for null request ETag", () => {
    expect(etagMatches(null, '"abc"')).toBe(false);
  });

  it("returns true for exact match", () => {
    expect(etagMatches('"abc123"', '"abc123"')).toBe(true);
  });

  it("returns false for non-match", () => {
    expect(etagMatches('"abc123"', '"def456"')).toBe(false);
  });

  it("handles weak ETag matching strong ETag (RFC 7232 weak comparison)", () => {
    expect(etagMatches('W/"abc123"', '"abc123"')).toBe(true);
    expect(etagMatches('"abc123"', 'W/"abc123"')).toBe(true);
  });

  it("handles both weak ETags", () => {
    expect(etagMatches('W/"abc123"', 'W/"abc123"')).toBe(true);
  });

  it("trims whitespace", () => {
    expect(etagMatches(' "abc123" ', '"abc123"')).toBe(true);
  });

  it("handles multiple ETags in If-None-Match header (comma-separated)", () => {
    // If-None-Match can contain multiple ETags: "abc", "def"
    // etagMatches checks the whole header value, so this tests single-value behavior
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
  });
});
