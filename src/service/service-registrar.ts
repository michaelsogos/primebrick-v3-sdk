import { NatsClient } from "../nats/nats-client.js";
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

  constructor(
    private readonly nats: typeof NatsClient,
    config: ServiceRegistrarConfig,
    private readonly healthCheckFn?: HealthCheckFn,
  ) {
    this.config = {
      heartbeatIntervalMs: 30000,
      is_behind_scaler: false,
      name: undefined,
      description: undefined,
      author: undefined,
      github_repo_url: undefined,
      service_version: undefined,
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
      http_healthy,
      nats_connected: this.nats.isConnected(),
      checks,
    };
    await this.nats.publish(SERVICE_SUBJECTS.REGISTER, payload);
    console.log(`[service] Registered ${this.config.serviceCode} via NATS`);
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
        http_healthy,
        nats_connected: this.nats.isConnected(),
        checks,
      };
      await this.nats.publish(SERVICE_SUBJECTS.HEARTBEAT, payload);
    } catch (error) {
      console.error(`[service] Heartbeat error for ${this.config.serviceCode}:`, error);
    }
  }

  async unregister(): Promise<void> {
    const payload: ServiceUnregisterPayload = {
      code: this.config.serviceCode,
      base_url: this.config.baseUrl,
      is_behind_scaler: this.config.is_behind_scaler,
    };
    await this.nats.publish(SERVICE_SUBJECTS.UNREGISTER, payload);
    console.log(`[service] Unregistered ${this.config.serviceCode} via NATS`);
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
