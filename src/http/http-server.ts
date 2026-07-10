import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { HealthCheck } from "./health-check.js";
import { extJsonStringify } from "../json/ext-json.js";

export interface HttpServerOptions {
  port: number;
  healthCheck?: HealthCheck;
  serviceName?: string;
  /** Custom route handler — receives req/res, returns true if handled. */
  routeHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
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
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    try {
      // Health check endpoint (public, no auth)
      if (url.pathname === "/health" && req.method === "GET") {
        if (options.healthCheck) {
          const results = await options.healthCheck.runAll();
          const healthy = options.healthCheck.isHealthy(results);
          res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
          res.end(extJsonStringify({ status: healthy ? "healthy" : "degraded", checks: results }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(extJsonStringify({ status: "healthy" }));
        }
        return;
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
        console.error(`[${options.serviceName ?? "microservice"}] Error after headers sent:`, err);
        res.destroy();
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

      console.error(`[${options.serviceName ?? "microservice"}] Unhandled error:`, {
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

  server.listen(options.port, () => {
    console.log(`HTTP server listening on port ${options.port}`);
  });

  return server;
}
