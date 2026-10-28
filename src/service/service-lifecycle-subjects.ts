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
  icon_type?: 'url' | 'base64' | 'icon';
  /**
   * Package name from the service's package.json — with `service_version`
   * it forms the canonical identity `{pkg_name}/{version}` (ua_prefix in
   * system.client_shield_registry, service_registry.pkg_name, log messages).
   */
  pkg_name?: string;
}

export interface ServiceRegisterPayload extends ServiceHeartbeatPayload {
  endpoints: Record<string, unknown>;
  /**
   * ROOT LEVEL the module belongs to (`part of`) — e.g. 'system' for
   * platform services, 'crm' for the CRM domain. Persisted in
   * `service_registry.part_of`; combined with `code` it derives the
   * module's FE route prefix `/{part_of}/{code}` — every declared
   * route_prefixes entry, nav href and routes entry must live under it
   * (enforced by the BE at registration).
   */
  part_of: string;
  /**
   * DEFAULT-MODULE CLAIM for the service's root level — `true` declares
   * this module as the landing app module of `part_of` (sidebar selects it
   * when the app is chosen → its nav[0].href). The BE applies keep-winner:
   * a claim colliding with a different holder is stored as `false`, never
   * rejected. `false`/absent never downgrades — an admin-set default
   * survives reboots.
   */
  is_default?: boolean;
  /**
   * i18n key for the module's localized display name — resolved by the FE
   * against this service's OWN translation namespace (same contract as
   * nav[].label_key). Persisted in `service_registry.label_key`; every UI
   * surface (breadcrumbs, app launcher, module menus) renders it, falling
   * back to the raw `name` when absent or the key is unresolved.
   */
  label_key?: string;
  /**
   * sha256 of the service's client shield key (module config
   * `service_client_shield_key`). The raw key NEVER travels — the BE
   * stores only this hash in client_shield_registry and verifies inbound
   * `x-primebrick-client-shield-key` by hashing+comparing.
   */
  client_key_hash?: string;
  /**
   * Key-rotation contract (B14): `key_mode='derived'` means the hash was
   * produced from `HMAC(derivation_secret, ua_prefix:key_generation)` — the
   * BE stores `key_generation` on the row and a rotate endpoint bumps it,
   * triggering re-registration with the next derived key. 'static' rows
   * carry a service-configured key and rotate only by admin action.
   */
  key_mode?: "static" | "derived";
  key_generation?: number;
  /**
   * Capabilities declared in the service's package.json
   * (`"capabilities": [...]`, snake_case lowercase) — e.g.
   * `llm_orchestrator`, `vectorizing_engine`. Persisted by the BE in
   * `service_registry.capabilities` and refreshed at every registration,
   * so the registry always reflects the deployed artifact.
   */
  capabilities?: string[];
  /**
   * PG schema ownership claim — the service's `DATABASE_SCHEMA` env list
   * (validated by `assertDbEnv`). The first schema is the owned one.
   * Persisted in `service_registry.schemas`: the BE rejects registration
   * when a claimed schema is owned by a different code, or is one of the
   * platform schemas (the BE's own `DATABASE_SCHEMA`, e.g.
   * public/system/custom). The claim survives offline/stale rows and is
   * released only by `service.unregister` or admin purge.
   */
  schemas?: string[];
  /**
   * How `code` was resolved (B3 — static service identity):
   * `derived`   — `code === pkg_name` minus the `primebrick-` prefix;
   *               the BE re-derives and rejects on mismatch.
   * `override`  — explicit `"service_code"` declared in the service's
   *               package.json; the BE accepts any valid code.
   * Absent (legacy payloads) is treated as `derived` — a code that does
   * not match its package name must be declared in the artifact.
   */
  code_source?: "derived" | "override";
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
  /** Status the stale-detection job just assigned: 'stale' or 'offline'. */
  status: string;
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
