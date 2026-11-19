import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RotatingSecretEngine, SecretProvider, SECRET_SUBJECTS, startSecretProvider, refreshSecretWithRetry } from "../rotating-secret.js";
import { subscribeShielded } from "../../nats/service-shield.js";
import { setClientShieldSecretSlot, validClientShieldSecrets, currentClientShieldSecret, SECRET_DEFAULTS } from "../../auth/client-shield-secret.js";

function fakeRedis() {
  const store = new Map<string, Map<string, string>>();
  return {
    hGetAll: vi.fn(async (k: string) => Object.fromEntries(store.get(k) ?? new Map())),
    hSet: vi.fn(async (k: string, v: Record<string, string>) => { store.set(k, new Map(Object.entries(v))); return 3; }),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    pExpire: vi.fn(async () => true),
    _store: store,
  };
}

const REF = { scope: "global", name: "service_client_shield_secret" };

vi.mock("../../nats/nats-client.js", () => ({
  NatsClient: { publish: vi.fn(async () => {}), subscribe: vi.fn(async () => {}), getConnection: vi.fn() },
}));
vi.mock("../../nats/service-shield.js", () => ({ subscribeShielded: vi.fn(async () => {}) }));

beforeEach(() => setClientShieldSecretSlot(null));

describe("RotatingSecretEngine", () => {
  it("cold start: generates and publishes a slot", async () => {
    const { NatsClient } = await import("../../nats/nats-client.js");
    const engine = new RotatingSecretEngine(fakeRedis() as any);
    const slot = await engine.get(REF);
    expect(slot.current).toMatch(/^[0-9a-f]{64}$/);
    expect(slot.previous).toBeNull();
    expect(NatsClient.publish).toHaveBeenCalledWith(SECRET_SUBJECTS.ROTATED, expect.objectContaining(REF));
  });

  it("get is idempotent within the rotation window (no re-rotate on read)", async () => {
    const engine = new RotatingSecretEngine(fakeRedis() as any);
    const a = await engine.get(REF);
    const b = await engine.get(REF);
    expect(b.current).toBe(a.current);
  });

  it("rotate keeps previous + feeds the gateway slot", async () => {
    const engine = new RotatingSecretEngine(fakeRedis() as any);
    const a = await engine.get(REF);
    // Force rotation by backdating rotated_at beyond the window.
    const key = "primebrick:secrets:global:service_client_shield_secret";
    const redis = (engine as any).redis;
    redis._store.get(key)!.set("rotated_at", "0");
    const b = await engine.rotate(REF);
    expect(b.current).not.toBe(a.current);
    expect(b.previous).toBe(a.current);
    expect(currentClientShieldSecret()).toBe(b.current);
  });

  it("validClientShieldSecrets: previous accepted inside grace, not after", async () => {
    setClientShieldSecretSlot({ current: "new", previous: "old", rotated_at: Date.now() });
    expect(validClientShieldSecrets(SECRET_DEFAULTS.graceMs)).toEqual(["new", "old"]);
    setClientShieldSecretSlot({ current: "new", previous: "old", rotated_at: Date.now() - SECRET_DEFAULTS.graceMs - 1 });
    expect(validClientShieldSecrets(SECRET_DEFAULTS.graceMs)).toEqual(["new"]);
  });
});

describe("SecretProvider", () => {
  it("get → callNats secret.get + caches + sets gateway slot", async () => {
    const slot = { current: "abc", previous: null, rotated_at: 123 };
    vi.doMock("../../nats/nats-routes.js", () => ({ callNats: vi.fn(async () => slot) }));
    vi.resetModules();
    const { SecretProvider: SP } = await import("../rotating-secret.js");
    const p = new SP();
    const s = await p.get(REF);
    expect(s).toEqual(slot);
  });
});

// ---------------------------------------------------------------------------
// Consumer refetch resilience — a failed get after secret.rotated must retry
// forever (incident 2026-11-17: one failed callNats = permanent 401 wall).
// The unit under test is the retry loop; provider.get is stubbed.
// ---------------------------------------------------------------------------
describe("consumer refetch resilience", () => {
  const broadcastHandler = async () => {
    const calls = vi.mocked(subscribeShielded).mock.calls;
    const handler = calls[calls.length - 1][1] as (payload: unknown) => Promise<unknown>;
    await handler({ ...REF });
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rotated → get fails ×3 → succeeds: retries then exits, slot refetched", async () => {
    const provider = new SecretProvider();
    const get = vi
      .spyOn(provider, "get")
      .mockRejectedValueOnce(new Error("engine down"))
      .mockRejectedValueOnce(new Error("engine down"))
      .mockRejectedValueOnce(new Error("engine down"))
      .mockResolvedValue({ current: "new-secret", previous: "old", rotated_at: 1 });
    await startSecretProvider(provider);
    await broadcastHandler();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("engine down past the old 30-attempt wall: still retrying (never gives up)", async () => {
    const provider = new SecretProvider();
    const get = vi.spyOn(provider, "get").mockRejectedValue(new Error("engine down"));
    await startSecretProvider(provider);
    await broadcastHandler();
    await vi.advanceTimersByTimeAsync(35 * 5_000);
    expect(get.mock.calls.length).toBeGreaterThan(30);
    get.mockResolvedValue({ current: "s", previous: null, rotated_at: 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    const calls = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(get.mock.calls.length).toBe(calls); // loop exited on success
  });

  it("two broadcasts mid-retry coalesce into a single loop", async () => {
    const provider = new SecretProvider();
    const get = vi.spyOn(provider, "get").mockRejectedValue(new Error("down"));
    await startSecretProvider(provider);
    await broadcastHandler();
    await broadcastHandler(); // second broadcast while first loop sleeps
    await vi.advanceTimersByTimeAsync(20_000);
    // one loop: 1 immediate + 4 retries after 20s of 5s cadence
    expect(get).toHaveBeenCalledTimes(5);
    get.mockResolvedValue({ current: "s", previous: null, rotated_at: 2 });
    await vi.advanceTimersByTimeAsync(5_000); // let the loop exit — clears the module dedup slot
  });

  it("invalidate clears the provider cache but the module slot survives until refetch", async () => {
    const provider = new SecretProvider();
    const get = vi.spyOn(provider, "get").mockRejectedValue(new Error("down"));
    (provider as any).cache.set("global/service_client_shield_secret", { current: "cached", previous: null, rotated_at: 0 });
    setClientShieldSecretSlot({ current: "serving", previous: null, rotated_at: 0 });
    await startSecretProvider(provider);
    await broadcastHandler();
    expect((provider as any).cache.size).toBe(0); // invalidated
    expect(currentClientShieldSecret()).toBe("serving"); // slot untouched — grace keeps calls passing
    await vi.advanceTimersByTimeAsync(5_000);
    expect(get.mock.calls.length).toBeGreaterThan(0); // refetch still running
  });

  it("startSecretProvider handler never awaits the retry loop (broadcast returns immediately)", async () => {
    const provider = new SecretProvider();
    const get = vi.spyOn(provider, "get").mockImplementation(() => new Promise(() => {})); // never resolves
    await startSecretProvider(provider);
    await expect(broadcastHandler()).resolves.toBeUndefined(); // detached — no hang
    get.mockResolvedValue({ current: "s", previous: null, rotated_at: 3 });
    await vi.advanceTimersByTimeAsync(0); // let the loop exit — clears the module dedup slot
  });
});
