/**
 * Ext-JSON — extended JSON serialization/deserialization for Primebrick.
 *
 * The canonical codec lives in `@primebrick/core` (environment-neutral,
 * strict three-stage parse: grammar + duplicate-key validation, native
 * materialization, flag-applied bigint walk). This module RE-EXPORTS it so
 * the SDK's public `json` surface and middleware keep working — there is
 * exactly one codec implementation in the workspace.
 *
 * Wire contract: standard JSON — bigint values are JSON numbers; ALL
 * integer-valued numbers parse back to native `bigint`, floats stay
 * `number`. No `number | bigint` ambiguity.
 *
 * Usage:
 * - BE: Express middleware via `extJsonMiddleware()`
 * - US: NATS message codec via `NatsClient.publish()` / `NatsClient.subscribe()`
 *   (the NatsClient methods use these functions internally — US code never
 *   calls extJsonStringify/extJsonParse directly)
 *
 * NOT for FE — the FE consumes the same codec via `@primebrick/ui`
 * (src/lib/api-ext.ts re-exports it).
 */

import type { Request, Response, NextFunction } from "express";

export { extJsonParse, extJsonStringify } from "@primebrick/core";
import { extJsonParse, extJsonStringify } from "@primebrick/core";

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
 * This parser uses `extJsonParse` which forces all integers to native `bigint`
 * and rejects malformed bodies — including duplicate keys — instead of
 * silently last-winning them.
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
