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

/**
 * Express middleware that parses request bodies with Ext-JSON.
 *
 * This replaces the default `express.json()` body parser for routes that need
 * to receive BigInt values without precision loss. Native `JSON.parse()` converts
 * large integers to `number`, losing precision above `Number.MAX_SAFE_INTEGER`.
 * This parser uses `extJsonParse` which forces all integers to native `bigint`.
 *
 * Install once in the Express app, BEFORE routes, typically replacing or
 * alongside `express.json()`. Only parses requests with `Content-Type: application/json`.
 *
 * Example:
 *   app.use(express.json({ limit: "1mb" })); // fallback for non-JSON content types
 *   app.use(extJsonBodyParser());             // ext-json for application/json
 *
 * Or as a per-route middleware for only the routes that need BigInt:
 *   router.put("/config/:uuid", extJsonBodyParser(), validateBody(schema), handler);
 *
 * Wire format: standard JSON with numbers (not strings) for bigint values.
 */
export function extJsonBodyParser(opts: { limit?: string | number } = {}) {
  const limit = opts.limit ?? "1mb";
  return async (req: Request, _res: Response, next: NextFunction) => {
    // Only parse for application/json content type
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      return next();
    }

    // Skip if body is already parsed (e.g. by express.json() earlier)
    if (req.body !== undefined && req.body !== null) {
      // Re-parse the raw body with ext-json if it was parsed by native JSON
      // We can't re-parse here because express.json() already consumed the stream.
      // The correct setup is to use extJsonBodyParser() INSTEAD of express.json()
      // for routes that need BigInt, or to use it as a per-route middleware
      // BEFORE validateBody. If express.json() already ran, we leave the body
      // as-is (native JSON — large integers may have lost precision).
      return next();
    }

    // Read the raw body from the stream
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const limitBytes = typeof limit === "number" ? limit : parseByteLimit(limit);

    return new Promise<void>((resolve) => {
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > limitBytes) {
          req.destroy();
          const err = new Error(`Body exceeds limit of ${limit}`) as Error & {
            status?: number;
          };
          err.status = 413;
          next(err);
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (raw.length === 0) {
          req.body = {};
        } else {
          try {
            req.body = extJsonParse(raw);
          } catch (err) {
            const e = new Error("Invalid JSON body") as Error & { status?: number };
            e.status = 400;
            next(e);
            resolve();
            return;
          }
        }
        next();
        resolve();
      });
      req.on("error", (err) => {
        next(err);
        resolve();
      });
    });
  };
}

/** Parse a human-readable byte limit string (e.g. "1mb", "100kb") to bytes. */
function parseByteLimit(s: string): number {
  const m = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(s.trim());
  if (!m) return 1024 * 1024;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? "b").toLowerCase();
  switch (unit) {
    case "b": return n;
    case "kb": return n * 1024;
    case "mb": return n * 1024 * 1024;
    case "gb": return n * 1024 * 1024 * 1024;
    default: return n;
  }
}
