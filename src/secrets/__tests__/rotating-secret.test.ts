import { describe, it, expect, vi, beforeEach } from "vitest";
import { RotatingSecretEngine, SecretProvider, SECRET_SUBJECTS } from "../rotating-secret.js";
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
