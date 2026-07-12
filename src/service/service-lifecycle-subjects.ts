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
 */

export const SERVICE_SUBJECTS = {
  REGISTER: "service.register",
  HEARTBEAT: "service.heartbeat",
  UNREGISTER: "service.unregister",
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
