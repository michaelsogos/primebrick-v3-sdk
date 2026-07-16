/**
 * Ext-JSON — extended JSON serialization/deserialization for Primebrick.
 *
 * Uses `json-bigint` with `useNativeBigInt: true` to preserve bigint values
 * across the JSON wire format. A reviver forces ALL integers to native `bigint`
 * (not just large ones), making types predictable: every integer is always
 * `bigint`, every float is always `number`. No `number | bigint` ambiguity.
 *
 * The wire format is standard JSON — bigint values are serialized as JSON
 * numbers (not strings), and parsed back to native bigint on the receiving end.
 *
 * Usage:
 * - BE: Express middleware via `extJsonMiddleware()`
 * - US: NATS message codec via `NatsClient.publish()` / `NatsClient.subscribe()`
 *   (the NatsClient methods use these functions internally — US code never
 *   calls extJsonStringify/extJsonParse directly)
 *
 * NOT for FE — the FE has its own standalone wrapper (src/lib/api-ext.ts).
 * The FE installs `json-bigint` directly and does NOT depend on @primebrick/sdk.
 */

import JSONBig from "json-bigint";
import type { Request, Response, NextFunction } from "express";

const jsonBigInstance = JSONBig({
  useNativeBigInt: true,
  strict: true,
});

/**
 * Serialize a value to an Ext-JSON string.
 * BigInt values are serialized as JSON numbers (e.g. 42n → "42").
 * Floats are serialized as JSON numbers (e.g. 3.14 → "3.14").
 */
export function extJsonStringify(data: unknown): string {
  return jsonBigInstance.stringify(data);
}

/**
 * Parse an Ext-JSON string.
 *
 * ALL integers are returned as native `bigint` (via reviver — alwaysParseAsBig
 * option in json-bigint v1.0.0 is broken for floats, so we use a reviver instead).
 * Floats (values with decimal point or scientific notation) are returned as `number`.
 * Strings, booleans, null are unaffected.
 *
 * This makes types predictable: every integer is always `bigint`, every float
 * is always `number`. No `number | bigint` ambiguity.
 */
export function extJsonParse<T = unknown>(text: string): T {
  return jsonBigInstance.parse(text, (_key, value) => {
    // Force all integer numbers to bigint (small integers come as `number`
    // from json-bigint; large integers already come as `bigint`).
    // Floats (Number.isInteger === false) stay as `number`.
    if (typeof value === "number" && Number.isInteger(value)) {
      return BigInt(value);
    }
    return value;
  }) as T;
}

/**
 * Express middleware that replaces `res.json()` with Ext-JSON serialization.
 * Install once in the Express app, before any routes.
 *
 * Example:
 *   app.use(extJsonMiddleware());
 *
 * Wire format: standard JSON with numbers (not strings) for bigint values.
 */
export function extJsonMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.json = ((data: unknown) => {
      // Express's default res.json() sends "null" for undefined — match that behavior.
      if (data === undefined) {
        res.setHeader("Content-Type", "application/json");
        res.send("null");
        return res;
      }
      const body = extJsonStringify(data);
      res.setHeader("Content-Type", "application/json");
      res.send(body);
      return res;
    }) as typeof res.json;
    next();
  };
}
