import { NatsClient } from "../nats/nats-client.js";
import { detectPackageIdentity, clientKeyHash } from "./service-identity.js";
import { logger } from "../lifecycle/logger.js";
import {
  SERVICE_SUBJECTS,
  type ServiceRegisterPayload,
  type ServiceHeartbeatPayload,
  type ServiceUnregisterPayload,
  type ServiceHealthCheck,
} from "./service-lifecycle-subjects.js";

export interface ServiceRegistrarConfig {
  serviceCode: string;
  baseUrl: string;
  endpoints: Record<string, unknown>;
  heartbeatIntervalMs?: number;
  name?: string;
  description?: string;
  author?: string;
  github_repo_url?: string;
  service_version?: string;
  is_behind_scaler?: boolean;
  icon?: string;
  icon_type?: 'url' | 'svg' | 'base64' | 'icon';
  /**
   * This service's own client key (module config `client_key`) — paired with
   * the UA prefix in `system.client_registry`. Only its sha256 hash is sent
   * in `service.register`; the raw key never leaves the service.
   */
  clientKey?: string;
}

/**
 * Health check function — returns the result of local health checks
 * (DB ping, NATS connectivity, etc.). The microservice injects this
 * so the registrar can include health status in heartbeats.
 */
export type HealthCheckFn = () => Promise<{
  http_healthy: boolean;
  checks: Record<string, ServiceHealthCheck>;
}>;

/**
 * Registers a microservice via NATS lifecycle events and maintains
 * a heartbeat.
 *
 * NATS-based: publishes to service.register / service.heartbeat /
 * service.unregister subjects. The BE subscribes and persists to the
 * `service_registry` table. The microservice never touches the DB directly.
 *
 * The healthCheckFn is called on each heartbeat to include the current
 * health status (HTTP + NATS + custom checks).
 */
export class ServiceRegistrar {
  private readonly config: Required<ServiceRegistrarConfig>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** sha256 of PRIMEBRICK_CLIENT_KEY — sent to the BE at register; raw key never leaves the service. */
  private readonly clientKeyHash?: string;
  private readonly pkgName: string;

  constructor(
    private readonly nats: typeof NatsClient,
    config: ServiceRegistrarConfig,
    private readonly healthCheckFn?: HealthCheckFn,
  ) {
    // Auto-derive name/version from package.json — the registry row must
    // always carry real identity (it feeds system.client_registry).
    const pkg = detectPackageIdentity();
    this.pkgName = pkg.name;
    // The client key is a module config (`client_key`), never an env var —
    // each service has its own key; only the sha256 hash leaves the service.
    const clientKey = config.clientKey;
    this.clientKeyHash = clientKey ? clientKeyHash(clientKey) : undefined;
    if (!clientKey) {
      logger.error(
        "config 'client_key' is not set — this service cannot enroll in system.client_registry; inbound identity verification will reject its callers",
        { tags: ["core"] },
      );
    }
    this.config = {
      heartbeatIntervalMs: 30000,
      is_behind_scaler: false,
      name: pkg.name,
      description: undefined,
      author: undefined,
      github_repo_url: undefined,
      service_version: pkg.version,
      icon: undefined,
      icon_type: undefined,
      ...config,
    } as Required<ServiceRegistrarConfig>;
  }

  async register(): Promise<void> {
    const { http_healthy, checks } = await this.runHealthChecks();
    const payload: ServiceRegisterPayload = {
      code: this.config.serviceCode,
      base_url: this.config.baseUrl,
      endpoints: this.config.endpoints,
      service_version: this.config.service_version,
      name: this.config.name,
      description: this.config.description,
      author: this.config.author,
      github_repo_url: this.config.github_repo_url,
      is_behind_scaler: this.config.is_behind_scaler,
      icon: this.config.icon,
      icon_type: this.config.icon_type,
      http_healthy,
      nats_connected: this.nats.isConnected(),
      checks,
      pkg_name: this.pkgName,
      client_key_hash: this.clientKeyHash,
    };
    await this.nats.publish(SERVICE_SUBJECTS.REGISTER, payload);
    logger.done(`Registered ${this.config.serviceCode} via NATS`, { tags: ["core"] });
  }

  async sendHeartbeat(): Promise<void> {
    try {
      const { http_healthy, checks } = await this.runHealthChecks();
      const payload: ServiceHeartbeatPayload = {
        code: this.config.serviceCode,
        base_url: this.config.baseUrl,
        service_version: this.config.service_version,
        name: this.config.name,
        description: this.config.description,
        author: this.config.author,
        github_repo_url: this.config.github_repo_url,
        is_behind_scaler: this.config.is_behind_scaler,
        icon: this.config.icon,
        icon_type: this.config.icon_type,
        http_healthy,
        nats_connected: this.nats.isConnected(),
        checks,
      };
      await this.nats.publish(SERVICE_SUBJECTS.HEARTBEAT, payload);
    } catch (error) {
      logger.error(`Heartbeat error for ${this.config.serviceCode}`, { tags: ["core"], error: error });
    }
  }

  async unregister(): Promise<void> {
    const payload: ServiceUnregisterPayload = {
      code: this.config.serviceCode,
      base_url: this.config.baseUrl,
      is_behind_scaler: this.config.is_behind_scaler,
    };
    await this.nats.publish(SERVICE_SUBJECTS.UNREGISTER, payload);
    logger.info(`Unregistered ${this.config.serviceCode} via NATS`, { tags: ["core"] });
  }

  startHeartbeat(): ReturnType<typeof setInterval> {
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.config.heartbeatIntervalMs);
    return this.heartbeatTimer;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async runHealthChecks(): Promise<{ http_healthy: boolean; checks: Record<string, ServiceHealthCheck> }> {
    if (this.healthCheckFn) {
      return this.healthCheckFn();
    }
    // Default: assume healthy if we can publish (NATS is connected)
    return {
      http_healthy: true,
      checks: {},
    };
  }
}
