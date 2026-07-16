import { describe, it, expect } from "vitest";
import { extJsonStringify, extJsonParse } from "../ext-json.js";

describe("ext-json", () => {
  describe("extJsonStringify", () => {
    it("serializes bigint as JSON number", () => {
      const result = extJsonStringify({ id: 42n, name: "test" });
      expect(result).toBe('{"id":42,"name":"test"}');
    });

    it("serializes large bigint as JSON number", () => {
      const result = extJsonStringify({ id: 99999999999999999999n });
      expect(result).toBe('{"id":99999999999999999999}');
    });

    it("serializes number (float) as JSON number", () => {
      const result = extJsonStringify({ price: 3.14 });
      expect(result).toBe('{"price":3.14}');
    });

    it("serializes null, boolean, string", () => {
      const result = extJsonStringify({ a: null, b: true, c: "hello" });
      expect(result).toBe('{"a":null,"b":true,"c":"hello"}');
    });

    it("serializes nested objects with bigint", () => {
      const result = extJsonStringify({ outer: { inner: 42n } });
      expect(result).toBe('{"outer":{"inner":42}}');
    });

    it("serializes arrays with bigint", () => {
      const result = extJsonStringify({ ids: [1n, 2n, 3n] });
      expect(result).toBe('{"ids":[1,2,3]}');
    });
  });

  describe("extJsonParse", () => {
    it("parses large integer as bigint", () => {
      const result = extJsonParse<{ id: bigint }>(
        '{"id":99999999999999999999}',
      );
      expect(result.id).toBe(99999999999999999999n);
      expect(typeof result.id).toBe("bigint");
    });

    it("parses small integer as bigint (alwaysParseAsBig)", () => {
      const result = extJsonParse<{ count: bigint }>('{"count":42}');
      expect(result.count).toBe(42n);
      expect(typeof result.count).toBe("bigint");
    });

    it("parses zero as bigint", () => {
      const result = extJsonParse<{ value: bigint }>('{"value":0}');
      expect(result.value).toBe(0n);
      expect(typeof result.value).toBe("bigint");
    });

    it("parses negative integer as bigint", () => {
      const result = extJsonParse<{ value: bigint }>('{"value":-42}');
      expect(result.value).toBe(-42n);
      expect(typeof result.value).toBe("bigint");
    });

    it("parses float as number (not bigint)", () => {
      const result = extJsonParse<{ price: number }>('{"price":3.14}');
      expect(result.price).toBe(3.14);
      expect(typeof result.price).toBe("number");
    });

    it("parses string, boolean, null", () => {
      const result = extJsonParse<{
        a: string;
        b: boolean;
        c: null;
      }>('{"a":"hello","b":true,"c":null}');
      expect(result.a).toBe("hello");
      expect(result.b).toBe(true);
      expect(result.c).toBeNull();
    });

    it("parses nested objects", () => {
      const result = extJsonParse<{ outer: { inner: bigint } }>(
        '{"outer":{"inner":42}}',
      );
      expect(result.outer.inner).toBe(42n);
      expect(typeof result.outer.inner).toBe("bigint");
    });

    it("parses arrays of integers as bigint", () => {
      const result = extJsonParse<{ ids: bigint[] }>('{"ids":[1,2,3]}');
      expect(result.ids).toEqual([1n, 2n, 3n]);
      expect(typeof result.ids[0]).toBe("bigint");
    });
  });

  describe("round-trip", () => {
    it("round-trips bigint through serialize/parse", () => {
      const original = { id: 1234567890123456789n, name: "test" };
      const json = extJsonStringify(original);
      const parsed = extJsonParse<{ id: bigint; name: string }>(json);
      expect(parsed.id).toBe(original.id);
      expect(typeof parsed.id).toBe("bigint");
      expect(parsed.name).toBe(original.name);
    });

    it("round-trips mixed bigint and float", () => {
      const original = { id: 42n, price: 3.14, count: 100n };
      const json = extJsonStringify(original);
      const parsed = extJsonParse<{
        id: bigint;
        price: number;
        count: bigint;
      }>(json);
      expect(parsed.id).toBe(42n);
      expect(typeof parsed.id).toBe("bigint");
      expect(parsed.price).toBe(3.14);
      expect(typeof parsed.price).toBe("number");
      expect(parsed.count).toBe(100n);
      expect(typeof parsed.count).toBe("bigint");
    });

    it("round-trips nested structures", () => {
      const original = {
        items: [{ id: 1n, qty: 5n }, { id: 2n, qty: 10n }],
        total: 15n,
        tax: 1.5,
      };
      const json = extJsonStringify(original);
      const parsed = extJsonParse<{
        items: { id: bigint; qty: bigint }[];
        total: bigint;
        tax: number;
      }>(json);
      expect(parsed.items[0].id).toBe(1n);
      expect(parsed.items[1].qty).toBe(10n);
      expect(parsed.total).toBe(15n);
      expect(parsed.tax).toBe(1.5);
      expect(typeof parsed.tax).toBe("number");
    });
  });
});
