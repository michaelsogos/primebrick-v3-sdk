import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { logger } from "../lifecycle/logger.js";
import { verifyClientIdentity } from "../service/service-identity.js";
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { HealthCheck } from "./health-check.js";
import { extJsonStringify } from "../json/ext-json.js";
import { extractTraceContext } from "../telemetry/otel.js";
import { mapDalError } from "../errors/dal-error-mapper.js";

export interface HttpServerOptions {
  port: number;
  healthCheck?: HealthCheck;
  serviceName?: string;
  /** Service version (from package.json) — included in /health response. */
  serviceVersion?: string;
  /** Base URL the service is listening on — included in /health response. */
  serviceUrl?: string;
  /** Custom route handler — receives req/res, returns true if handled. */
  routeHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  /**
   * Client-identity gate (B11): when set, every non-/health request must
   * carry a registry-listed `User-Agent` prefix + valid
   * `x-primebrick-client-key` before the route handler runs.
   */
  clientRegistry?: import("../service/client-registry.js").ClientRegistry;
}

/**
 * RFC 7807 Problem Details response for microservice errors.
 * Every US HTTP response uses this format — same structure as the BE error handler.
 */
function sendRfcError(
  res: ServerResponse,
  status: number,
  title: string,
  detail: string,
  options?: { type?: string; internal_code?: string; instance?: string; severity?: string },
): void {
  const body = {
    type: options?.type ?? `https://primebrick.io/errors/${options?.internal_code ?? "error"}`,
    title,
    status,
    detail,
    instance: options?.instance,
    internal_code: options?.internal_code,
    severity: options?.severity,
  };
  const json = extJsonStringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

/**
 * Minimal HTTP server with health endpoint. Uses native http module (no Express).
 * All errors (unhandled routes, route handler crashes, auth errors) are returned
 * as RFC 7807 Problem Details JSON — same format as the BE error handler.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<Server> {
  const tracer = trace.getTracer("@primebrick/sdk", options.serviceVersion ?? "unknown");
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // OpenTelemetry server span — uniform across Node and Bun (auto-
    // instrumentation of node:http is unreliable on Bun, so we do it
    // manually here; instrumentation-http is disabled on Node to avoid
    // double spans). Noop when telemetry is disabled.
    const parentCtx = extractTraceContext(req.headers);
    const span = tracer.startSpan(
      `${req.method} ${url.pathname}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": req.method ?? "UNKNOWN",
          "url.path": url.pathname,
          "url.query": url.search || undefined,
          "service.name": options.serviceName ?? "microservice",
        },
      },
      parentCtx,
    );
    res.on("finish", () => {
      span.setAttribute("http.response.status_code", res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });

    await context.with(trace.setSpan(parentCtx, span), async () => {
      try {
      // Health check endpoint (public, no auth)
      if (url.pathname === "/health" && req.method === "GET") {
        if (options.healthCheck) {
          const payload = await options.healthCheck.toResponse(
            options.serviceName ?? "microservice",
            options.serviceVersion ?? "unknown",
            options.serviceUrl,
          );
          res.writeHead(payload.ok ? 200 : 503, { "Content-Type": "application/json" });
          res.end(extJsonStringify(payload));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(extJsonStringify({
            ok: true,
            service: options.serviceName ?? "microservice",
            version: options.serviceVersion ?? "unknown",
            url: options.serviceUrl,
            checks: {},
          }));
        }
        return;
      }

      // Client-identity gate — internal callers must identify themselves
      // (User-Agent prefix + client key) before any route runs.
      if (options.clientRegistry) {
        const registry = options.clientRegistry;
        const headerAdapter = {
          headers: {
            get: (name: string) => {
              const v = req.headers[name.toLowerCase()];
              return typeof v === "string" ? v : null;
            },
          },
        };
        const idResult = await verifyClientIdentity(headerAdapter, {
          allowedPrefixes: registry.allowedPrefixes,
          verifyKey: (prefix, key) => registry.verifyKey(prefix, key),
        });
        if (!idResult.ok) {
          sendRfcError(
            res,
            idResult.status,
            idResult.error === "UNKNOWN_CLIENT" ? "Unknown client" : "Unidentified client",
            idResult.error === "UNKNOWN_CLIENT"
              ? "User-Agent is not in the client registry allowlist"
              : "Missing or invalid client identity headers",
            {
              internal_code: idResult.error,
              instance: url.pathname,
              severity: "MEDIUM",
            },
          );
          return;
        }
      }

      // Custom routes
      if (options.routeHandler) {
        const handled = await options.routeHandler(req, res, url);
        if (handled) return;
      }

      // No route matched — RFC 7807 404
      sendRfcError(res, 404, "Not Found", `No route matched ${req.method} ${url.pathname}`, {
        internal_code: "ROUTE_NOT_FOUND",
        instance: url.pathname,
        severity: "LOW",
      });
    } catch (err) {
      // If headers already sent (route handler started writing then threw),
      // we can't send a proper RFC response — just destroy the socket.
      if (res.headersSent) {
        logger.error(`Error after headers sent`, { tags: ["core"], error: err });
        res.destroy();
        return;
      }

      // DAL errors (ERR01–ERR07, 57014, NOT_FOUND…) → typed RFC 7807 via the
      // shared mapper — same mapping as the BE errorHandler.
      const mapped = mapDalError(err, url.pathname);
      if (mapped) {
        res.writeHead(mapped.status, { "Content-Type": "application/json" });
        res.end(extJsonStringify(mapped.body));
        return;
      }

      // Auth errors and RBAC errors carry internal_code — extract it
      const isAuthError = err instanceof Error && "internal_code" in err;
      const internalCode = isAuthError
        ? (err as { internal_code: string }).internal_code
        : "INTERNAL_ERROR";
      const status = isAuthError
        ? (err as { status?: number }).status ?? 401
        : 500;

      logger.error("Unhandled error", {
        tags: ["core"],
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        name: err instanceof Error ? err.name : undefined,
        internal_code: internalCode,
        path: url.pathname,
        method: req.method,
      });

      sendRfcError(
        res,
        status,
        err instanceof Error ? err.name : "Internal Server Error",
        err instanceof Error ? err.message : "An unexpected error occurred",
        {
          internal_code: internalCode,
          instance: url.pathname,
          severity: status >= 500 ? "HIGH" : "MEDIUM",
        },
      );
      }
    });
  });

  server.listen(options.port, () => {
    logger.done(`HTTP server listening on port ${options.port}`, { tags: ["core"] });
  });

  return server;
}
