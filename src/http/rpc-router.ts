/**
 * makeRpcRouter — the ONLY legal way to expose non-entity HTTP routes on a
 * microservice. Closed-by-design counterpart of the BE's `makeEntityRouter`:
 * the mandatory chain (auth → RBAC → validation → ONE handler → RFC 7807)
 * is baked in and cannot be bypassed by the consumer.
 *
 * Auth kinds:
 *   "user"    — GATEWAY-RESOLVED: verify gateway secret + AuthUser headers
 *   "api_key" — API key verification via ApiKeyPort (e.g. S2S receivers)
 *   "public"  — explicitly unauthenticated (openapi.json); auditable because
 *               it must be declared in the route definition
 *
 * `streaming: "sse"` is a governed route kind: the handler receives an
 * SseWriter and owns the response; the router skips JSON serialization.
 *
 * Everything not produced by this factory (or makeEntityRouter) is dead
 * code: `createMicroservice` mounts only factory-produced route handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extJsonParse, extJsonStringify } from "../json/ext-json.js";
import { verifyHttpRequest } from "../auth/verify-http.js";
import { verifyApiKey } from "../auth/verify-api-key.js";
import { HttpHeaderProvider } from "../auth/header-provider.js";
import { getAuthConfig } from "../auth/auth-config-cache.js";
import { enforceHttpRbac } from "../auth/rbac-enforce.js";
import { AuthError } from "../auth/verify.js";
import { RbacDeniedError } from "../auth/rbac-enforce.js";
import type { AuthUser } from "../auth/types.js";
import type { ApiKeyPort } from "../auth/ports/api-key-port.js";
import { createSseWriter } from "../sse/sse-writer.js";
import type { SseWriter } from "../sse/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type RpcAuthKind = "user" | "api_key" | "public";
export type RpcMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RpcRouteContext<
  TBody = unknown,
  TParams extends Record<string, string> = Record<string, string>,
> {
  /** Resolved caller — undefined only for `auth: "public"` routes. */
  user?: AuthUser;
  /** Path params extracted from `:name` segments. */
  params: TParams;
  query: URLSearchParams;
  /** Parsed+validated body (output of the route's `body` validator). */
  body: TBody;
  req: IncomingMessage;
  res: ServerResponse;
  /** Present only when `streaming: "sse"` — handler owns the response. */
  sse?: SseWriter;
}

export interface RpcRoute<
  TBody = unknown,
  TParams extends Record<string, string> = Record<string, string>,
> {
  method: RpcMethod;
  /** Absolute path, `:param` segments supported (e.g. "/api/v1/ai/conversations/:uuid"). */
  path: string;
  /**
   * RBAC permissions — MANDATORY for `auth: "user"`/`"api_key"` routes.
   * Only `auth: "public"` routes may omit it.
   */
  permissions?: readonly string[];
  rbacMode?: "any" | "all";
  /** Auth kind. Default "user" (gateway-resolved). */
  auth?: RpcAuthKind;
  /**
   * Body validator — receives the raw parsed JSON and returns the parsed
   * body. Throw anything to produce a 400 VALIDATION_ERROR (use zod's
   * `.parse`, or a manual shape check).
   */
  body?: (raw: unknown) => TBody;
  /** "sse" = governed streaming route: handler gets `ctx.sse`, owns res. */
  streaming?: "sse";
  /**
   * OpenAPI metadata — consumed by `rpcSpec()`/`buildOpenApiSpec()` to emit
   * this route in the service's auto-generated `/api/v1/openapi.json`.
   * Routes without it are still documented (path+method+security derived),
   * but `summary`/`description`/schemas make them first-class.
   */
  openapi?: import("./openapi.js").RpcRouteOpenApi;
  /** The ONE service call — business logic lives behind it, not here. */
  handler: (ctx: RpcRouteContext<TBody, TParams>) => Promise<unknown>;
}

export interface RpcRouterDeps {
  /** Required only if any route uses `auth: "api_key"`. */
  apiKeyPort?: ApiKeyPort;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean>;

// ─── Internals ──────────────────────────────────────────────────────────────

interface CompiledRoute {
  route: RpcRoute;
  regex: RegExp;
  paramNames: string[];
}

function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) return undefined;
  try {
    return extJsonParse(text);
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function sendRfcError(
  res: ServerResponse,
  status: number,
  title: string,
  detail: string,
  options?: { internal_code?: string; instance?: string; severity?: string },
): void {
  const body = {
    type: `https://primebrick.io/errors/${options?.internal_code ?? "error"}`,
    title,
    status,
    detail,
    instance: options?.instance,
    internal_code: options?.internal_code,
    severity: options?.severity ?? (status >= 500 ? "HIGH" : "MEDIUM"),
  };
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(extJsonStringify(body));
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a routeHandler for `createHttpServer`/`createMicroservice` from a
 * list of governed route declarations. Returns `true` when a route handled
 * the request, `false` when no path matched (chaining, same contract as the
 * legacy composite handlers).
 *
 * Fails fast at construction time on invalid declarations — an endpoint
 * without permissions that isn't explicitly `auth: "public"` never exists.
 */
export function makeRpcRouter(routes: RpcRoute[], deps: RpcRouterDeps = {}): RouteHandler {
  const compiled: CompiledRoute[] = routes.map((route) => {
    const auth = route.auth ?? "user";
    if (auth !== "public" && (!route.permissions || route.permissions.length === 0)) {
      throw new Error(
        `makeRpcRouter: route ${route.method} ${route.path} has no permissions. ` +
          `Every non-public endpoint MUST declare RBAC permissions — ` +
          `use auth: "public" only for genuinely unauthenticated routes.`,
      );
    }
    if (auth === "api_key" && !deps.apiKeyPort) {
      throw new Error(
        `makeRpcRouter: route ${route.method} ${route.path} uses auth "api_key" ` +
          `but no apiKeyPort was provided in router deps.`,
      );
    }
    return { route, ...compilePath(route.path) };
  });

  return async (req, res, url) => {
    const path = url.pathname;
    const match = compiled.find((c) => c.regex.test(path));
    if (!match) return false;

    const { route, regex, paramNames } = match;
    const auth = route.auth ?? "user";

    try {
      // Method not allowed for a matched path — still "handled".
      if (req.method !== route.method) {
        sendRfcError(res, 405, "Method Not Allowed", `${req.method} not allowed on ${path}`, {
          internal_code: "METHOD_NOT_ALLOWED",
          instance: path,
          severity: "LOW",
        });
        return true;
      }

      // ── Mandatory middleware chain ──
      let user: AuthUser | undefined;
      if (auth === "user") {
        user = await verifyHttpRequest(req, getAuthConfig());
      } else if (auth === "api_key") {
        user = await verifyApiKey(new HttpHeaderProvider(req), deps.apiKeyPort!);
      }
      if (route.permissions?.length) {
        enforceHttpRbac(user!, route.permissions, route.rbacMode);
      }

      let body: unknown;
      if (route.body) {
        try {
          body = route.body(await readJsonBody(req));
        } catch (e) {
          throw new ValidationError(e instanceof Error ? e.message : String(e));
        }
      }

      const m = path.match(regex)!;
      const params = Object.fromEntries(paramNames.map((n, i) => [n, m[i + 1]!]));

      const ctx: RpcRouteContext = {
        user,
        params,
        query: url.searchParams,
        body,
        req,
        res,
      };
      if (route.streaming === "sse") {
        ctx.sse = createSseWriter(res);
      }

      const result = await route.handler(ctx as never);

      if (!res.writableEnded) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(extJsonStringify(result ?? null));
      }
      return true;
    } catch (err) {
      if (res.headersSent) throw err; // let the server destroy the socket
      if (err instanceof AuthError) {
        sendRfcError(res, 401, "Unauthorized", err.message, {
          internal_code: err.internal_code,
          instance: path,
        });
      } else if (err instanceof RbacDeniedError) {
        sendRfcError(res, 403, "Forbidden", "Insufficient permissions", {
          internal_code: "RBAC_PERMISSION_DENIED",
          instance: path,
        });
      } else if (err instanceof ValidationError) {
        sendRfcError(res, 400, "Validation Error", err.message, {
          internal_code: "VALIDATION_ERROR",
          instance: path,
          severity: "LOW",
        });
      } else {
        throw err; // DAL errors etc. → http-server's mapDalError/RFC7807
      }
      return true;
    }
  };
}

/** Compose multiple factory-produced routers — same chaining contract. */
export function composeRouteHandlers(...handlers: RouteHandler[]): RouteHandler {
  return async (req, res, url) => {
    for (const h of handlers) {
      if (await h(req, res, url)) return true;
    }
    return false;
  };
}
