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
   * Body validator — receives the raw parsed JSON (or the raw text when
   * `rawBody` is set) and returns the parsed body. Throw anything to
   * produce a 400 VALIDATION_ERROR (use zod's `.parse`, or a manual
   * shape check).
   */
  body?: (raw: unknown) => TBody;
  /**
   * Read the body as raw text instead of parsing JSON — for pass-through
   * routes (e.g. webhook ingress) that must forward the payload verbatim.
   */
  rawBody?: boolean;
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
  /**
   * Required only if any route uses `auth: "api_key"`. Either the port
   * itself or a lazy getter resolved at request time (for ports wired
   * after router construction, e.g. `authDependencySetters`).
   */
  apiKeyPort?: ApiKeyPort | (() => ApiKeyPort | null | undefined);
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean>;

// ─── Factory brand (runtime enforcement) ────────────────────────────────────
// `Symbol.for` (global registry) so the brand survives multiple SDK copies
// in the same process (e.g. tsx + bundled dist).

const ROUTE_HANDLER_BRAND: unique symbol = Symbol.for(
  "primebrick.sdk.factory-route-handler",
);

export function brandRouteHandler(h: RouteHandler): RouteHandler {
  (h as unknown as Record<symbol, unknown>)[ROUTE_HANDLER_BRAND] = true;
  return h;
}

/**
 * True when `h` was produced by an approved factory — `makeRpcRouter`,
 * `composeRouteHandlers`, or `makeOpenApiHandler`. `createMicroservice`
 * refuses to mount anything else at startup.
 */
export function isFactoryRouteHandler(h: unknown): h is RouteHandler {
  return (
    typeof h === "function" &&
    (h as unknown as Record<symbol, unknown>)[ROUTE_HANDLER_BRAND] === true
  );
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface CompiledRoute {
  route: RpcRoute;
  regex: RegExp;
  paramNames: string[];
}

function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segs = path.split("/");
  // Trailing wildcard `:name*` — captures zero or more remaining
  // segments (optional). Only legal as the last segment.
  let suffix = "";
  let wildcardName: string | null = null;
  const last = segs[segs.length - 1];
  if (last.startsWith(":") && last.endsWith("*")) {
    if (segs.some((s, i) => i < segs.length - 1 && s.endsWith("*"))) {
      throw new Error(`compilePath: wildcard ":param*" is only allowed as the last segment (${path})`);
    }
    wildcardName = last.slice(1, -1);
    segs.pop();
    suffix = "(?:/(.*))?";
  }
  const pattern = segs
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  // The wildcard capture is the LAST group — push its name after the
  // positional params so indices line up with the regex groups.
  if (wildcardName) paramNames.push(wildcardName);
  return { regex: new RegExp(`^${pattern}${suffix}$`), paramNames };
}

async function readTextBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readTextBody(req);
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

  const resolveApiKeyPort = (): ApiKeyPort | null | undefined =>
    typeof deps.apiKeyPort === "function" ? deps.apiKeyPort() : deps.apiKeyPort;

  return brandRouteHandler(async (req, res, url) => {
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
        const port = resolveApiKeyPort();
        if (!port) {
          sendRfcError(res, 500, "Auth Not Initialized", "Auth dependencies not initialized", {
            internal_code: "AUTH_NOT_INITIALIZED",
            instance: path,
          });
          return true;
        }
        user = await verifyApiKey(new HttpHeaderProvider(req), port);
      }
      if (route.permissions?.length) {
        enforceHttpRbac(user!, route.permissions, route.rbacMode);
      }

      let body: unknown;
      if (route.body || route.rawBody) {
        try {
          const raw = route.rawBody ? await readTextBody(req) : await readJsonBody(req);
          body = route.body ? route.body(raw) : raw;
        } catch (e) {
          if (e instanceof ValidationError) throw e;
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
        // Lazy writer: writeHead(200, SSE_HEADERS) fires on the FIRST send/
        // close, not at construction — so the handler can still setHeader
        // (e.g. X-Conversation-UUID) after middleware ran but before the
        // first event goes out.
        let inner: SseWriter | null = null;
        const writer = () => (inner ??= createSseWriter(res));
        ctx.sse = {
          send: (event) => writer().send(event),
          comment: (text) => writer().comment(text),
          close: () => writer().close(),
          get closed() {
            return inner?.closed ?? false;
          },
        };
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
  });
}

/**
 * Compose multiple factory-produced routers — same chaining contract.
 * Throws at construction time if any handler is not factory-produced:
 * composition is an extension of the closed set, not a smuggling hatch.
 */
export function composeRouteHandlers(...handlers: RouteHandler[]): RouteHandler {
  for (const h of handlers) {
    if (!isFactoryRouteHandler(h)) {
      throw new Error(
        "composeRouteHandlers: every handler must be produced by an approved " +
          "factory (makeRpcRouter / makeOpenApiHandler / composeRouteHandlers). " +
          "Arbitrary route functions are rejected — migrate the route to an " +
          "RpcRoute declaration.",
      );
    }
  }
  return brandRouteHandler(async (req, res, url) => {
    for (const h of handlers) {
      if (await h(req, res, url)) return true;
    }
    return false;
  });
}
