import type { HealthCheckPort } from "../ports/health-check-port.js";
import type { HealthCheckResult, HealthResponse } from "./health-response.js";

export type { HealthCheckResult, HealthResponse } from "./health-response.js";

/**
 * Health check utility. Extracted from BE's index.ts:126-148 pattern.
 * Checks DB connectivity (via HealthCheckPort) and optional custom checks.
 *
 * DB-agnostic: depends on HealthCheckPort, NOT on pg.Pool.
 * The consumer provides an adapter that runs whatever their DB uses
 * (e.g. `SELECT 1` for PG).
 *
 * Produces a unified `HealthResponse` via `toResponse()` — used by both
 * the BE (Express) and US (createHttpServer) `/health` endpoints.
 */
export class HealthCheck {
  constructor(
    private readonly dbPing: HealthCheckPort,
    private readonly customChecks: Record<string, () => Promise<HealthCheckResult>> = {},
  ) {}

  async checkDb(): Promise<HealthCheckResult> {
    try {
      const ok = await this.dbPing.ping();
      return { ok };
    } catch {
      return { ok: false };
    }
  }

  async runAll(): Promise<Record<string, HealthCheckResult>> {
    const results: Record<string, HealthCheckResult> = {
      db: await this.checkDb(),
    };
    for (const [name, check] of Object.entries(this.customChecks)) {
      try {
        results[name] = await check();
      } catch (e) {
        results[name] = { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
      }
    }
    return results;
  }

  isHealthy(results: Record<string, HealthCheckResult>): boolean {
    return Object.values(results).every((r) => r.ok);
  }

  /**
   * Build a unified `HealthResponse` from all checks.
   * Used by both BE and US `/health` endpoints.
   */
  async toResponse(service: string, version: string, url?: string): Promise<HealthResponse> {
    const checks = await this.runAll();
    return {
      ok: this.isHealthy(checks),
      service,
      version,
      url,
      checks,
    };
  }
}
