/**
 * NATS subjects and payload types for microservice lifecycle events.
 *
 * Microservices publish these events via NATS. The BE subscribes and
 * persists the state to the `service_registry` table.
 *
 * Flow:
 *   - On startup: microservice publishes `service.register`
 *   - Every 30s: microservice publishes `service.heartbeat`
 *   - On graceful shutdown: microservice publishes `service.unregister`
 *   - On NATS reconnect: microservice publishes immediate `service.heartbeat`
 *
 * The BE also publishes `service.stale` internally (from the stale-detection
 * job) when a service's heartbeat is older than the stale threshold. This is
 * NOT published by microservices — it is a BE-internal event.
 */

export const SERVICE_SUBJECTS = {
  REGISTER: "service.register",
  HEARTBEAT: "service.heartbeat",
  UNREGISTER: "service.unregister",
  STALE: "service.stale",
} as const;

export interface ServiceHealthCheck {
  ok: boolean;
  error?: string;
}

export interface ServiceHeartbeatPayload {
  code: string;
  base_url: string;
  service_version?: string;
  name?: string;
  description?: string;
  author?: string;
  github_repo_url?: string;
  is_behind_scaler: boolean;
  http_healthy: boolean;
  nats_connected: boolean;
  checks: Record<string, ServiceHealthCheck>;
  icon?: string;
  icon_type?: 'url' | 'svg' | 'base64' | 'icon';
}

export interface ServiceRegisterPayload extends ServiceHeartbeatPayload {
  endpoints: Record<string, unknown>;
}

export interface ServiceUnregisterPayload {
  code: string;
  base_url: string;
  is_behind_scaler: boolean;
}

/**
 * Payload for `service.stale` — published by the BE's stale-detection job
 * when a service's `last_health_check_at` exceeds the stale threshold.
 *
 * This is NOT published by microservices. It is a BE-internal event that
 * allows all BE instances (and their SSE clients) to learn about stale
 * services in real time.
 */
export interface ServiceStalePayload {
  code: string;
  base_url: string;
  is_behind_scaler: boolean;
  /** ISO 8601 timestamp of the last heartbeat received. */
  last_health_check_at: string;
}
