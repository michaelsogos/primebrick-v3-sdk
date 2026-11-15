import { describe, it, expect, vi, beforeEach } from "vitest";
import { callNats } from "../../nats/nats-routes.js";
import { subscribeShielded } from "../../nats/service-shield.js";
import { ClientShieldRegistry, CLIENT_SHIELD_REGISTRY_SUBJECTS } from "../client-shield-registry.js";

vi.mock("../../nats/nats-routes.js", () => ({ callNats: vi.fn() }));
vi.mock("../../nats/service-shield.js", () => ({ subscribeShielded: vi.fn() }));

const callNatsMock = vi.mocked(callNats);
const subscribeMock = vi.mocked(subscribeShielded);

const ROW = {
  ua_prefix: "primebrick-api/3.3.0",
  client_key_hash: "h1",
  is_enabled: true,
  key_generation: 0,
  previous_key_hash: null,
  previous_valid_until: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  subscribeMock.mockResolvedValue(undefined);
});

// refresh() is the thin forced re-fetch the NATS shield drives on a
// stale-snapshot denial: it returns whether the row material changed.
// Listener notification and failure resilience live in the .changed
// broadcast handler wired by start().
describe("ClientShieldRegistry.refresh", () => {
  it("re-fetches the snapshot and returns true when the material changed", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    const listener = vi.fn();
    reg.addChangeListener(listener);

    await expect(reg.refresh()).resolves.toBe(true);
    expect(callNatsMock).toHaveBeenCalledWith(CLIENT_SHIELD_REGISTRY_SUBJECTS.GET, null, { timeoutMs: 5000 });
    expect(reg.allowedPrefixes).toEqual(["primebrick-api/3.3.0"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns false when the material is unchanged", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();

    await expect(reg.refresh()).resolves.toBe(true);
    await expect(reg.refresh()).resolves.toBe(false);
  });

  it("learns a newly enrolled prefix on the next refresh (new-version client)", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    await reg.refresh();
    expect(reg.allowedPrefixes).not.toContain("primebrick-crm/3.4.0");

    callNatsMock.mockImplementation(async () => [ROW, { ...ROW, ua_prefix: "primebrick-crm/3.4.0" }]);
    await expect(reg.refresh()).resolves.toBe(true);
    expect(reg.allowedPrefixes).toContain("primebrick-crm/3.4.0");
  });

  it("rejects when the fetch fails — the previous snapshot is kept", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    await reg.refresh();

    callNatsMock.mockRejectedValue(new Error("CLIENT_IDENTITY_DENIED: client identity rejected"));
    await expect(reg.refresh()).rejects.toThrow("CLIENT_IDENTITY_DENIED");
    expect(reg.allowedPrefixes).toEqual(["primebrick-api/3.3.0"]);
  });
});

describe("ClientShieldRegistry.start", () => {
  it("wires the .changed broadcast to a reload that notifies listeners on material change", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    const listener = vi.fn();
    reg.addChangeListener(listener);
    await reg.start();

    const [subject, handler] = subscribeMock.mock.calls[0];
    expect(subject).toBe(CLIENT_SHIELD_REGISTRY_SUBJECTS.CHANGED);

    // Let the boot snapshot (reloadUntilOk) settle, then feed the broadcast
    // handler genuinely new material — an unchanged reload must not notify.
    await reg.refresh();
    await new Promise((r) => setTimeout(r, 0));

    callNatsMock.mockImplementation(async () => [ROW, { ...ROW, ua_prefix: "primebrick-crm/3.4.0" }]);
    await handler(null, {} as never);

    expect(reg.allowedPrefixes).toContain("primebrick-crm/3.4.0");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous snapshot and does not throw when the broadcast reload fails", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    await reg.start();
    const [, handler] = subscribeMock.mock.calls[0];

    await reg.refresh();
    await new Promise((r) => setTimeout(r, 0));

    callNatsMock.mockRejectedValue(new Error("CLIENT_IDENTITY_DENIED: client identity rejected"));
    await expect(handler(null, {} as never)).resolves.toBeUndefined();
    expect(reg.allowedPrefixes).toEqual(["primebrick-api/3.3.0"]);
  });
});
