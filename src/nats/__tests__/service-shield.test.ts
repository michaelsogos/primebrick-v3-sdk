import { describe, it, expect, afterEach, vi } from "vitest";
import { headers as natsHeaders, type Msg } from "@nats-io/transport-node";
import { verifyNatsPublisher, setNatsShieldRegistry, type ShieldRegistryLike } from "../service-shield.js";
import { CLIENT_SHIELD_KEY_HEADER } from "../../service/service-identity.js";

function msg(ua: string): { subject?: string; headers?: Msg["headers"] } {
  const h = natsHeaders();
  h.set("user-agent", ua);
  h.set(CLIENT_SHIELD_KEY_HEADER, "presented-key");
  return { subject: "system.client_shield_registry.changed", headers: h };
}

afterEach(() => {
  setNatsShieldRegistry(null);
});

describe("verifyNatsPublisher stale-snapshot recovery", () => {
  it("accepts a publisher enrolled after the last refresh: 403 → refresh → retry passes", async () => {
    const fake: ShieldRegistryLike & { allowedPrefixes: string[] } = {
      allowedPrefixes: ["primebrick-api/3.3.0"],
      verifyKey: () => true,
      refresh: vi.fn(async () => {
        // simulates the snapshot fetch learning the newly-enrolled client
        fake.allowedPrefixes = ["primebrick-api/3.3.0", "primebrick-crm/3.4.0"];
      }),
    };
    setNatsShieldRegistry(fake);

    expect(await verifyNatsPublisher(msg("primebrick-crm/3.4.0 (crm) Node/x"))).toBe(true);
    expect(fake.refresh).toHaveBeenCalled();
  });

  it("still rejects a genuinely unknown client when the refresh does not learn it", async () => {
    const fake: ShieldRegistryLike = {
      allowedPrefixes: ["primebrick-api/3.3.0"],
      verifyKey: () => true,
      refresh: vi.fn(async () => {}),
    };
    setNatsShieldRegistry(fake);

    expect(await verifyNatsPublisher(msg("rogue-client/1.0.0 (x) Node/x"))).toBe(false);
  });

  it("still rejects when the registry exposes no refresh (fail-closed)", async () => {
    setNatsShieldRegistry({
      allowedPrefixes: ["primebrick-api/3.3.0"],
      verifyKey: () => true,
    });

    expect(await verifyNatsPublisher(msg("primebrick-crm/3.4.0 (crm) Node/x"))).toBe(false);
  });

  it("warms up an empty registry via refresh before the first verify", async () => {
    const fake: ShieldRegistryLike & { allowedPrefixes: string[] } = {
      allowedPrefixes: [],
      verifyKey: () => true,
      refresh: vi.fn(async () => {
        fake.allowedPrefixes = ["primebrick-api/3.3.0"];
      }),
    };
    setNatsShieldRegistry(fake);

    expect(await verifyNatsPublisher(msg("primebrick-api/3.3.0 (backend) Node/x"))).toBe(true);
    expect(fake.refresh).toHaveBeenCalled();
  });
});
