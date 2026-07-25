/**
 * In-process SSE event bus.
 *
 * Distributes `SseEvent`s to all subscribed SSE endpoints within a single BE
 * process. Each BE instance has its own bus — multi-instance fanout is handled
 * by NATS (every instance subscribes to the same NATS subjects and bridges
 * them to its local bus).
 *
 * Redis pubsub is NOT used for SSE fanout. NATS is the messaging backbone.
 *
 * @see {@link docs/user-guide/sse-standard.mdx} for the full SSE standard.
 */

import type { SseEventBus, SseEvent, SseEventBusSubscription } from "./types.js";

/**
 * Create a new in-process `SseEventBus`.
 *
 * Typically created once as a singleton per BE process and shared across all
 * SSE endpoints that need the same event stream.
 *
 * @example
 * ```typescript
 * import { createSseEventBus } from "@primebrick/sdk";
 * export const serviceEventsBus = createSseEventBus();
 * ```
 */
export function createSseEventBus(): SseEventBus {
  const handlers = new Set<(event: SseEvent) => void>();

  return {
    emit(event: SseEvent) {
      for (const h of handlers) {
        try {
          h(event);
        } catch (err) {
          // A single handler error must not crash the bus or other subscribers.
          console.error("[SseEventBus] handler error:", err);
        }
      }
    },

    subscribe(handler: (event: SseEvent) => void): SseEventBusSubscription {
      handlers.add(handler);
      return {
        unsubscribe() {
          handlers.delete(handler);
        },
      };
    },

    close() {
      handlers.clear();
    },
  };
}
