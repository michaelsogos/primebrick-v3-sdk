import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  makeDbMigrationRouteHandler,
  MIGRATION_ROUTE_PREFIX,
} from "../migration-routes.js";
import { isFactoryRouteHandler } from "../rpc-router.js";
import type {
  DbMigrationBootOptions,
  MigrationBootState,
} from "../../microservice/db-migration-step.js";

function stubRes(status?: { code: number }): ServerResponse {
  return {
    writeHead: (code: number) => {
      if (status) status.code = code;
      return stubRes(status);
    },
    setHeader: () => {},
    end: () => {},
  } as unknown as ServerResponse;
}

async function hits(
  h: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>,
  method: string,
  path: string,
): Promise<boolean> {
  const status = { code: 0 };
  try {
    const r = await h(
      { method, headers: {} } as IncomingMessage,
      stubRes(status),
      new URL(`http://x${path}`),
    );
    return r && status.code !== 405;
  } catch (err) {
    if (err instanceof Error && err.message.includes("loadAuthConfig")) return true;
    throw err;
  }
}

function boot(): DbMigrationBootOptions {
  return {
    engine: {
      runMigrations: vi.fn(),
      registryStatus: vi.fn(async () => []),
      retryFailedPatches: vi.fn(async () => 0),
      approvePendingReview: vi.fn(),
      resolveManually: vi.fn(),
      checkDrift: vi.fn(),
      isDriftClean: vi.fn(),
    },
    pool: () => ({}),
    schema: () => "svc",
    patchesDir: "/patches",
  };
}

const state: MigrationBootState = {
  result: null,
  degraded: true,
  lastError: "boom",
  appliedCount: 0,
};

describe("makeDbMigrationRouteHandler", () => {
  const h = makeDbMigrationRouteHandler(boot(), state, async () => {});

  it("returns a factory-branded handler (createMicroservice accepts it)", () => {
    expect(isFactoryRouteHandler(h)).toBe(true);
  });

  it("registers the full admin remediation surface", async () => {
    expect(await hits(h, "GET", `${MIGRATION_ROUTE_PREFIX}/status`)).toBe(true);
    expect(await hits(h, "POST", `${MIGRATION_ROUTE_PREFIX}/retry`)).toBe(true);
    expect(await hits(h, "POST", `${MIGRATION_ROUTE_PREFIX}/approve`)).toBe(true);
    expect(await hits(h, "POST", `${MIGRATION_ROUTE_PREFIX}/resolve`)).toBe(true);
    expect(await hits(h, "POST", `${MIGRATION_ROUTE_PREFIX}/drift-check`)).toBe(true);
  });

  it("accepts the optional onRecovered hook (deferred boot init)", () => {
    expect(() => makeDbMigrationRouteHandler(boot(), state)).not.toThrow();
    expect(() => makeDbMigrationRouteHandler(boot(), state, async () => {})).not.toThrow();
  });
});
