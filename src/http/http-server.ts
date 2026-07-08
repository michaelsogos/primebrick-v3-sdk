import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
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
 * Minimal HTTP server with health endpoint. Extracted from emailsender's
 * server/http-server.ts:1-64. Uses native http module (no Express).
 * No DB dependency.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // Health check endpoint
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

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(options.port, () => {
    console.log(`HTTP server listening on port ${options.port}`);
  });

  return server;
}
