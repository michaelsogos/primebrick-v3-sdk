import { describe, it, expect, vi } from "vitest";
import {
  rerunMigrations,
  makeRunOnceInit,
  type DbMigrationBootOptions,
  type MigrationBootState,
  type MigrationRunResultLike,
} from "../db-migration-step.js";

function result(over: Partial<MigrationRunResultLike> = {}): MigrationRunResultLike {
  return {
    mode: "apply",
    degraded: false,
    applied: [],
    failed: [],
    pendingReview: [],
    skipped: [],
    securityEvents: [],
    ...over,
  };
}

function boot(runMigrations: ReturnType<typeof vi.fn>): DbMigrationBootOptions {
  return {
    engine: {
      runMigrations,
      registryStatus: vi.fn(),
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

function state(over: Partial<MigrationBootState> = {}): MigrationBootState {
  return { result: null, degraded: true, lastError: "boom", appliedCount: 0, ...over };
}

describe("rerunMigrations", () => {
  it("rewrites state live on success — unlatches degraded", async () => {
    const runMigrations = vi.fn(async () => result({ applied: ["p1"] }));
    const s = state();
    const r = await rerunMigrations(boot(runMigrations), s, "actor-x");
    expect(r.degraded).toBe(false);
    expect(s.degraded).toBe(false);
    expect(s.lastError).toBeNull();
    expect(s.appliedCount).toBe(1);
    expect(s.result).toBe(r);
  });

  it("keeps degraded and surfaces first failure error", async () => {
    const runMigrations = vi.fn(async () =>
      result({ degraded: true, failed: [{ patch_name: "p2", error: "syntax" }] }),
    );
    const s = state();
    const r = await rerunMigrations(boot(runMigrations), s, "actor-x");
    expect(r.degraded).toBe(true);
    expect(s.degraded).toBe(true);
    expect(s.lastError).toBe("syntax");
  });

  it("passes actor + default release trust to the engine", async () => {
    const runMigrations = vi.fn(async () => result());
    await rerunMigrations(boot(runMigrations), state(), "auto-remediation:svc");
    expect(runMigrations).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "auto-remediation:svc", allowedTrust: ["release"] }),
    );
  });
});

describe("makeRunOnceInit", () => {
  it("runs init once — subsequent calls are no-ops", async () => {
    const init = vi.fn(async () => {});
    const once = makeRunOnceInit(init);
    await once();
    await once();
    await once();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers share the same in-flight init", async () => {
    let release!: () => void;
    const init = vi.fn(() => new Promise<void>((res) => (release = res)));
    const once = makeRunOnceInit(init);
    const p1 = once();
    const p2 = once();
    expect(init).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([p1, p2]);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("a failed init clears the memo — next call retries", async () => {
    const init = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);
    const once = makeRunOnceInit(init);
    await expect(once()).rejects.toThrow("transient");
    await once(); // retry succeeds and latches
    await once();
    expect(init).toHaveBeenCalledTimes(2);
  });
});
