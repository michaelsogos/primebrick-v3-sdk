/**
 * SSE (Server-Sent Events) types for Primebrick.
 *
 * These types define the contract for SSE event production and distribution
 * within the BE process. The BE bridges NATS lifecycle events to an in-process
 * event bus, which SSE endpoints subscribe to and forward to connected clients.
 *
 * @see {@link docs/user-guide/sse-standard.mdx} for the full SSE development standard.
 */

/**
 * A single SSE event to be sent to a client.
 *
 * - `id`: Unique event identifier. Used by the FE for `Last-Event-ID` on reconnect
 *   and for deduplication. Format: `<resource>:<timestamp>:<nonce>` or any
 *   deterministic string.
 * - `event`: Event type in dot notation (e.g. `service.heartbeat`, `snapshot`).
 * - `data`: Payload object. Serialized via `extJsonStringify` (BigInt-safe).
 *   Date objects are serialized as ISO strings (standard JSON behavior).
 */
export interface SseEvent<T = unknown> {
  id: string;
  event: string;
  data: T;
}

/**
 * Writer abstraction over an Express SSE response.
 *
 * Handles SSE wire format (W3C EventSource): `id:`, `event:`, `data:` fields
 * followed by a blank line. Comments are sent as `: <text>\n\n`.
 */
export interface SseWriter {
  /** Send a structured SSE event. No-op if the connection is already closed. */
  send(event: SseEvent): void;
  /** Send a comment line (used for keep-alive). No-op if closed. */
  comment(text: string): void;
  /** Close the underlying response. Idempotent. */
  close(): void;
  /** Whether the underlying connection has been closed. */
  readonly closed: boolean;
}

/**
 * Subscription handle returned by `SseEventBus.subscribe()`.
 * Call `unsubscribe()` to stop receiving events and clean up.
 */
export interface SseEventBusSubscription {
  unsubscribe(): void;
}

/**
 * In-process event bus for distributing SSE events to all connected clients
 * within a single BE instance.
 *
 * Multi-instance fanout is handled by NATS: every BE instance subscribes to
 * the same NATS subjects and bridges them to its local bus. Redis pubsub is
 * NOT used — NATS is the messaging backbone.
 */
export interface SseEventBus {
  /** Emit an event to all subscribers. Handler errors are caught and logged. */
  emit(event: SseEvent): void;
  /** Subscribe to all events on this bus. Returns a subscription handle. */
  subscribe(handler: (event: SseEvent) => void): SseEventBusSubscription;
  /** Close the bus and remove all subscribers. */
  close(): void;
}
