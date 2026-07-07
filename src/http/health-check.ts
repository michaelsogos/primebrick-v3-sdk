import type { HealthCheckPort } from "../ports/health-check-port.js";

export interface HealthCheckResult {
  ok: boolean;
  [key: string]: unknown;
}

/**
 * Health check utility. Extracted from BE's index.ts:126-148 pattern.
 * Checks DB connectivity (via HealthCheckPort) and optional custom checks.
 *
 * DB-agnostic: depends on HealthCheckPort, NOT on pg.Pool.
 * The consumer provides an adapter that runs whatever their DB uses
 * (e.g. `SELECT 1` for PG).
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
}
