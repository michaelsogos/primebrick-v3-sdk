/**
 * SSE writer utility for Node.js HTTP responses.
 *
 * Sets the correct SSE headers and provides a typed `SseWriter` that handles
 * the W3C EventSource wire format. Uses `extJsonStringify` for BigInt-safe
 * serialization of event data.
 *
 * Accepts a raw `http.ServerResponse` — works with both Express (whose
 * `Response` extends `ServerResponse`) and framework-agnostic microservices
 * that use the raw Node.js HTTP server (e.g. the AI microservice).
 *
 * @see {@link docs/user-guide/sse-standard.mdx} for the full SSE standard.
 */

import type { ServerResponse } from "node:http";
import { extJsonStringify } from "../json/ext-json.js";
import type { SseWriter, SseEvent } from "./types.js";

/**
 * SSE response headers per the Primebrick SSE standard.
 *
 * - `Cache-Control: no-cache, no-transform` — prevent proxy buffering/transform
 * - `X-Accel-Buffering: no` — disable nginx response buffering
 * - `Connection: keep-alive` — persistent connection
 * - `X-Content-Type-Options: nosniff` — security header
 */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Create an `SseWriter` backed by a Node.js HTTP `ServerResponse`.
 *
 * Works with both Express responses (Express `Response` extends
 * `http.ServerResponse`) and raw `http.ServerResponse` from framework-agnostic
 * microservices (e.g. the AI microservice's `createMicroservice` route handler).
 *
 * Immediately writes the SSE headers and flushes them. The caller is responsible
 * for sending an initial `snapshot` event and setting up keep-alive + cleanup.
 *
 * @example Express
 * ```typescript
 * router.get("/api/v1/system/services/events", rbacHandler([...]), (req, res) => {
 *   const writer = createSseWriter(res);
 *   writer.send({ id: "snapshot:1", event: "snapshot", data: { services: [] } });
 *   const sub = bus.subscribe((ev) => writer.send(ev));
 *   const ka = setInterval(() => writer.comment("keep-alive"), 15_000);
 *   req.on("close", () => { sub.unsubscribe(); clearInterval(ka); writer.close(); });
 * });
 * ```
 *
 * @example Raw http.ServerResponse (microservice)
 * ```typescript
 * function handleChat(req: IncomingMessage, res: ServerResponse) {
 *   const writer = createSseWriter(res);
 *   writer.send({ event: "text-delta", data: { text: "Hello" } });
 *   writer.close();
 * }
 * ```
 */
export function createSseWriter(res: ServerResponse): SseWriter {
  res.writeHead(200, SSE_HEADERS);
  // flushHeaders ensures headers are sent immediately, before any event data.
  res.flushHeaders?.();

  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  return {
    send(event: SseEvent) {
      if (closed) return;
      let chunk = "";
      if (event.id) chunk += `id: ${event.id}\n`;
      if (event.event) chunk += `event: ${event.event}\n`;
      // extJsonStringify handles BigInt (as JSON numbers) and Date (as ISO strings).
      // Single-line JSON — SSE data must not contain raw newlines.
      chunk += `data: ${extJsonStringify(event.data)}\n\n`;
      res.write(chunk);
    },

    comment(text: string) {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },

    close() {
      if (!closed) {
        closed = true;
        res.end();
      }
    },

    get closed() {
      return closed;
    },
  };
}
