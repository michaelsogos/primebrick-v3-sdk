/**
 * Bridge NATS subjects → SSE event bus.
 *
 * Subscribes to one or more NATS subjects and forwards each message as an
 * `SseEvent` on the provided `SseEventBus`. This is the mechanism that connects
 * the event-driven NATS backbone to SSE endpoints: every BE instance subscribes
 * to the same NATS subjects and bridges them to its local bus, which SSE
 * endpoints then forward to connected clients.
 *
 * @see {@link docs/user-guide/sse-standard.mdx} for the full SSE standard.
 */

import type { Subscription } from "nats";
import { NatsClient } from "../nats/nats-client.js";
import type { SseEventBus } from "./types.js";

/**
 * Mapping from a NATS subject to an SSE event type.
 *
 * - `subject`: The NATS subject to subscribe to (e.g. `service.heartbeat`).
 * - `eventType`: The SSE `event:` field value (e.g. `service.heartbeat`).
 * - `transform`: Converts the NATS payload into an `{ id, data }` pair for
 *   the SSE event. The `id` should be deterministic for deduplication.
 */
export interface NatsSseBridgeMapping {
  subject: string;
  eventType: string;
  transform: (payload: unknown) => { id: string; data: unknown };
}

/**
 * Subscribe to NATS subjects and bridge their messages to an SSE event bus.
 *
 * Returns a cleanup function that unsubscribes all NATS subscriptions.
 * Call it on graceful shutdown or when the bridge is no longer needed.
 *
 * @example
 * ```typescript
 * const cleanup = await bridgeNatsToSse(NatsClient, serviceEventsBus, [
 *   {
 *     subject: SERVICE_SUBJECTS.HEARTBEAT,
 *     eventType: "service.heartbeat",
 *     transform: (p) => ({ id: `hb:${p.code}:${Date.now()}`, data: p }),
 *   },
 * ]);
 * // On shutdown:
 * cleanup();
 * ```
 */
export async function bridgeNatsToSse(
  nats: typeof NatsClient,
  bus: SseEventBus,
  mappings: NatsSseBridgeMapping[],
): Promise<() => void> {
  const subs: Subscription[] = [];

  for (const m of mappings) {
    const sub = await nats.subscribe(m.subject, async (payload) => {
      const { id, data } = m.transform(payload);
      bus.emit({ id, event: m.eventType, data });
    });
    subs.push(sub);
  }

  return () => {
    for (const s of subs) {
      try {
        s.unsubscribe();
      } catch {
        // Subscription may already be closed — ignore.
      }
    }
  };
}
