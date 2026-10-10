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
  /**
   * Published BY the BE once its lifecycle subscriber is up (startup).
   * Registered services re-send `service.register` — a gateway restart is
   * the moment that sanitizes service continuity (endpoints, capabilities,
   * OpenAPI rediscovery). Fire-and-forget: not a poll, the BE never asks.
   */
  GATEWAY_ONLINE: "service.gateway_online",
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
  /**
   * Package name from the service's package.json — with `service_version`
   * it forms the canonical identity `{pkg_name}/{version}` (ua_prefix in
   * system.client_registry, service_registry.pkg_name, log messages).
   */
  pkg_name?: string;
}

export interface ServiceRegisterPayload extends ServiceHeartbeatPayload {
  endpoints: Record<string, unknown>;
  /**
   * sha256 of the service's client shield key (module config
   * `service_client_shield_key`). The raw key NEVER travels — the BE
   * stores only this hash in client_registry and verifies inbound
   * `x-primebrick-client-shield-key` by hashing+comparing.
   */
  client_key_hash?: string;
  /**
   * Capabilities declared in the service's package.json
   * (`"capabilities": [...]`, snake_case lowercase) — e.g.
   * `llm_orchestrator`, `vectorizing_engine`. Persisted by the BE in
   * `service_registry.capabilities` and refreshed at every registration,
   * so the registry always reflects the deployed artifact.
   */
  capabilities?: string[];
}

export interface ServiceUnregisterPayload {
  code: string;
  base_url: string;
  is_behind_scaler: boolean;
  pkg_name?: string;
  service_version?: string;
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

/**
 * Payload for `service.gateway_online` — published by the BE when its
 * lifecycle subscriber is ready. Registered services respond by re-sending
 * `service.register` so the restarted gateway re-ingests identity,
 * endpoints and capabilities (and re-discovers OpenAPI).
 */
export interface ServiceGatewayOnlinePayload {
  /** ISO 8601 timestamp of the gateway boot. */
  at: string;
}
