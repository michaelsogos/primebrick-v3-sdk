import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MsgHdrs } from "@nats-io/transport-node";

// `callNats` is the ClientShieldRegistry snapshot fetch — mocked so refresh()
// can be driven with staged registry rows (no broker needed).
const mockCallNats = vi.hoisted(() => vi.fn());
vi.mock("../../nats/nats-routes.js", () => ({ callNats: mockCallNats }));

import {
  setNatsShieldRegistry,
  verifyNatsPublisher,
  type ShieldRegistryLike,
} from "../service-shield.js";
import { publishJobResultMessage, NatsClient } from "../nats-client.js";
import { clientKeyHash, CLIENT_SHIELD_KEY_HEADER } from "../../service/service-identity.js";
import { ClientShieldRegistry } from "../../service/client-shield-registry.js";

/** Case-sensitive MsgHdrs stand-in (nats.js: `get` → "" for missing keys). */
function hdrs(entries: Record<string, string>): MsgHdrs {
  const map = new Map(Object.entries(entries));
  return { get: (k: string) => map.get(k) ?? "" } as unknown as MsgHdrs;
}

/** Mutable in-memory registry — `refresh` applies the staged rows, mirroring
 *  the real class's reload-from-server semantics. */
function makeRegistry(staged: Map<string, string>) {
  const current = new Map<string, string>();
  const apply = () => {
    current.clear();
    for (const [k, v] of staged) current.set(k, v);
  };
  const refresh = vi.fn(async () => {
    apply();
    return true;
  });
  const reg: ShieldRegistryLike = {
    get allowedPrefixes() {
      return [...current.keys()];
    },
    verifyKey: (prefix, key) => current.get(prefix) === clientKeyHash(key),
    refresh,
  };
  return { reg, refresh, apply };
}

const UA = "primebrick-svc/1.0.0";
const KEY = "ck-test-key";

beforeEach(() => {
  vi.clearAllMocks();
  setNatsShieldRegistry(null);
});

describe("verifyNatsPublisher — stale-snapshot recovery", () => {
  it("accepts a valid UA+key with no refresh", async () => {
    const staged = new Map([[UA, clientKeyHash(KEY)]]);
    const { reg, refresh, apply } = makeRegistry(staged);
    apply();
    setNatsShieldRegistry(reg);
    const ok = await verifyNatsPublisher({
      subject: "emailsender.send",
      headers: hdrs({ "user-agent": UA, [CLIENT_SHIELD_KEY_HEADER]: KEY }),
    });
    expect(ok).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("401 INVALID_CLIENT_SHIELD_KEY → refresh + retry accepts the rotated hash", async () => {
    // Cache holds the OLD hash; the publisher already presents the NEW key —
    // the rotation's changed-broadcast was missed (fire-and-forget core pub).
    // verifyKey fails until the refresh lands the rotated hash.
    let rotated = false;
    const reg: ShieldRegistryLike = {
      allowedPrefixes: [UA],
      verifyKey: (prefix, key) => rotated && key === "ck-rotated" && prefix === UA,
      refresh: vi.fn(async () => {
        rotated = true;
        return true;
      }),
    };
    setNatsShieldRegistry(reg);
    const ok = await verifyNatsPublisher({
      subject: "emailsender.send",
      headers: hdrs({ "user-agent": UA, [CLIENT_SHIELD_KEY_HEADER]: "ck-rotated" }),
    });
    expect(ok).toBe(true);
    expect(reg.refresh).toHaveBeenCalledTimes(1);
  });

  it("403 UNKNOWN_CLIENT → refresh + retry accepts the newly enrolled prefix", async () => {
    let enrolled = false;
    const reg: ShieldRegistryLike = {
      get allowedPrefixes() {
        return enrolled ? [UA, "primebrick-new/"] : [UA];
      },
      verifyKey: () => true,
      refresh: vi.fn(async () => {
        enrolled = true;
        return true;
      }),
    };
    setNatsShieldRegistry(reg);
    const ok = await verifyNatsPublisher({
      subject: "jobs.due.user.job.forward.x",
      headers: hdrs({ "user-agent": "primebrick-new/2.0.0", [CLIENT_SHIELD_KEY_HEADER]: "k" }),
    });
    expect(ok).toBe(true);
    expect(reg.refresh).toHaveBeenCalledTimes(1);
  });

  it("persistent denial after refresh still fails closed", async () => {
    const reg: ShieldRegistryLike = {
      allowedPrefixes: [UA],
      verifyKey: () => false,
      refresh: vi.fn(async () => false),
    };
    setNatsShieldRegistry(reg);
    const ok = await verifyNatsPublisher({
      subject: "emailsender.send",
      headers: hdrs({ "user-agent": UA, [CLIENT_SHIELD_KEY_HEADER]: "wrong" }),
    });
    expect(ok).toBe(false);
    expect(reg.refresh).toHaveBeenCalledTimes(1);
  });

  it("empty snapshot warms up via refresh before the first verify", async () => {
    let warmed = false;
    const reg: ShieldRegistryLike = {
      get allowedPrefixes() {
        return warmed ? [UA] : [];
      },
      verifyKey: () => true,
      refresh: vi.fn(async () => {
        warmed = true;
        return true;
      }),
    };
    setNatsShieldRegistry(reg);
    const ok = await verifyNatsPublisher({
      subject: "emailsender.send",
      headers: hdrs({ "user-agent": UA, [CLIENT_SHIELD_KEY_HEADER]: "k" }),
    });
    expect(ok).toBe(true);
    expect(reg.refresh).toHaveBeenCalledTimes(1);
  });

  it("no registry configured → skipped (test-context path)", async () => {
    setNatsShieldRegistry(null);
    const ok = await verifyNatsPublisher({ subject: "x", headers: hdrs({}) });
    expect(ok).toBe(true);
  });
});

describe("publishJobResultMessage — correlation contract", () => {
  beforeEach(() => {
    vi.spyOn(NatsClient, "jetstreamPublish").mockResolvedValue({ seq: 1n } as never);
  });

  it("headers win over the envelope fallback", async () => {
    const spy = vi.spyOn(NatsClient, "jetstreamPublish");
    await publishJobResultMessage(
      "jobs.due.user.job.forward.abc",
      hdrs({ "x-job-schedule-subject": "jobs.schedule.hdr" }),
      { status: "failed", error_code: "DENIED" },
      { schedule_subject: "jobs.schedule.body" },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("jobs.result.job.forward.abc");
    expect(spy.mock.calls[0]![1]).toMatchObject({ schedule_subject: "jobs.schedule.hdr" });
  });

  it("envelope schedule_subject correlates a header-less denial", async () => {
    const spy = vi.spyOn(NatsClient, "jetstreamPublish");
    await publishJobResultMessage(
      "jobs.due.user.job.forward.abc",
      hdrs({}),
      { status: "failed", error_code: "DENIED" },
      { schedule_subject: "jobs.schedule.body" },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatchObject({
      status: "failed",
      error_code: "DENIED",
      schedule_subject: "jobs.schedule.body",
    });
  });

  it("no headers + no fallback → silent no-op (uncorrelated result is unsendable)", async () => {
    const spy = vi.spyOn(NatsClient, "jetstreamPublish");
    await publishJobResultMessage("emailsender.send", hdrs({}), { status: "failed" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("ClientShieldRegistry.refresh", () => {
  it("reloads the snapshot — new hash verifies, changed=true", async () => {
    const reg = new ClientShieldRegistry();
    mockCallNats.mockResolvedValue([
      { ua_prefix: UA, client_key_hash: clientKeyHash(KEY), is_enabled: true },
    ]);
    expect(await reg.refresh()).toBe(true); // empty → populated = material change
    expect(reg.allowedPrefixes).toEqual([UA]);
    expect(reg.verifyKey(UA, KEY)).toBe(true);
    expect(reg.verifyKey(UA, "other")).toBe(false);
  });

  it("identical snapshot → changed=false", async () => {
    const reg = new ClientShieldRegistry();
    const rows = [{ ua_prefix: UA, client_key_hash: clientKeyHash(KEY), is_enabled: true }];
    mockCallNats.mockResolvedValue(rows);
    await reg.refresh();
    mockCallNats.mockResolvedValue([...rows]);
    expect(await reg.refresh()).toBe(false);
  });

  it("rotation → verifyKey accepts the new hash after refresh", async () => {
    const reg = new ClientShieldRegistry();
    mockCallNats.mockResolvedValueOnce([
      { ua_prefix: UA, client_key_hash: clientKeyHash("ck-old"), is_enabled: true },
    ]);
    await reg.refresh();
    expect(reg.verifyKey(UA, "ck-new")).toBe(false);
    mockCallNats.mockResolvedValueOnce([
      { ua_prefix: UA, client_key_hash: clientKeyHash("ck-new"), is_enabled: true },
    ]);
    expect(await reg.refresh()).toBe(true);
    expect(reg.verifyKey(UA, "ck-new")).toBe(true);
  });

  it("disabled rows are excluded from the snapshot", async () => {
    const reg = new ClientShieldRegistry();
    mockCallNats.mockResolvedValue([
      { ua_prefix: UA, client_key_hash: clientKeyHash(KEY), is_enabled: false },
    ]);
    await reg.refresh();
    expect(reg.allowedPrefixes).toEqual([]);
    expect(reg.verifyKey(UA, KEY)).toBe(false);
  });
});
