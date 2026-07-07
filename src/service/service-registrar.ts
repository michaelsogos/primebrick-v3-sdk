import type { ServiceRegistryPort } from "../ports/service-registry-port.js";
import type { IServiceRegistry } from "./service-registry.js";

export interface ServiceRegistrarConfig {
  serviceCode: string;
  baseUrl: string;
  endpoints: Record<string, unknown>;
  heartbeatIntervalMs?: number;
}

/**
 * Registers a microservice in `service_registry` and maintains
 * a heartbeat. Extracted from emailsender's ServiceRegistration
 * (service-registration.ts:1-101).
 *
 * DB-agnostic: depends on ServiceRegistryPort, NOT on getDal() or
 * @primebrick/dal-pg. The consumer provides an adapter that implements
 * ServiceRegistryPort using their DAL.
 */
export class ServiceRegistrar {
  private readonly config: ServiceRegistrarConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repo: ServiceRegistryPort,
    config: ServiceRegistrarConfig,
  ) {
    this.config = {
      heartbeatIntervalMs: 60000,
      ...config,
    };
  }

  async register(): Promise<void> {
    const existing = await this.repo.findByCode(this.config.serviceCode);

    if (existing) {
      await this.repo.updateByCode(this.config.serviceCode, {
        code: this.config.serviceCode,
        base_url: this.config.baseUrl,
        endpoints: this.config.endpoints,
      });
      console.log(`Updated service registration: ${this.config.serviceCode}`);
    } else {
      await this.repo.insert({
        code: this.config.serviceCode,
        base_url: this.config.baseUrl,
        endpoints: this.config.endpoints,
      });
      console.log(`Registered new service: ${this.config.serviceCode}`);
    }
  }

  async updateHeartbeat(): Promise<void> {
    try {
      await this.repo.updateByCode(this.config.serviceCode, {
        base_url: this.config.baseUrl,
      });
    } catch (error) {
      console.error("Error updating heartbeat:", error);
    }
  }

  startHeartbeat(): ReturnType<typeof setInterval> {
    this.heartbeatTimer = setInterval(() => this.updateHeartbeat(), this.config.heartbeatIntervalMs);
    return this.heartbeatTimer;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
