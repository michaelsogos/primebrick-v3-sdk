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

describe("ClientShieldRegistry.refresh", () => {
  it("re-fetches the snapshot and notifies listeners when the material changed", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    const listener = vi.fn();
    reg.addChangeListener(listener);

    await reg.refresh();

    expect(callNatsMock).toHaveBeenCalledWith(CLIENT_SHIELD_REGISTRY_SUBJECTS.GET, null, { timeoutMs: 5000 });
    expect(reg.allowedPrefixes).toEqual(["primebrick-api/3.3.0"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify listeners when the material is unchanged", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    const listener = vi.fn();
    reg.addChangeListener(listener);

    await reg.refresh();
    await reg.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies listeners when a new prefix is enrolled (new-version client)", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    const listener = vi.fn();
    reg.addChangeListener(listener);
    await reg.refresh();
    expect(reg.allowedPrefixes).not.toContain("primebrick-crm/3.4.0");

    callNatsMock.mockImplementation(async () => [ROW, { ...ROW, ua_prefix: "primebrick-crm/3.4.0" }]);
    await reg.refresh();

    expect(reg.allowedPrefixes).toContain("primebrick-crm/3.4.0");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous snapshot and does not throw when the fetch fails", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    await reg.refresh();

    callNatsMock.mockRejectedValue(new Error("CLIENT_IDENTITY_DENIED: client identity rejected"));
    await expect(reg.refresh()).resolves.toBeUndefined();

    expect(reg.allowedPrefixes).toEqual(["primebrick-api/3.3.0"]);
  });
});

describe("ClientShieldRegistry.start", () => {
  it("wires the .changed broadcast to refresh()", async () => {
    callNatsMock.mockImplementation(async () => [ROW]);
    const reg = new ClientShieldRegistry();
    await reg.start();

    const [subject, handler] = subscribeMock.mock.calls[0];
    expect(subject).toBe(CLIENT_SHIELD_REGISTRY_SUBJECTS.CHANGED);

    callNatsMock.mockClear();
    await handler(null, {} as never);

    expect(callNatsMock).toHaveBeenCalledWith(CLIENT_SHIELD_REGISTRY_SUBJECTS.GET, null, { timeoutMs: 5000 });
  });
});
