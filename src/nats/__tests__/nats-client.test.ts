import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the nats module
vi.mock("nats", () => {
  const close = vi.fn(async () => {});
  const jetstream = vi.fn(() => ({ js: true }));
  const nc = { close, jetstream };
  const connect = vi.fn(async () => nc);
  return { connect, NatsConnection: {}, JetStreamClient: {} };
});

import { NatsClient } from "../nats-client.js";
import { connect as natsConnect } from "nats";

describe("NatsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton state via close
    NatsClient.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getConnection returns a connection and connects once (singleton)", async () => {
    const nc1 = await NatsClient.getConnection();
    const nc2 = await NatsClient.getConnection();
    expect(nc1).toBe(nc2);
    expect(natsConnect).toHaveBeenCalledTimes(1);
  });

  it("getJetStream throws before getConnection()", () => {
    expect(() => NatsClient.getJetStream()).toThrow(/not initialized/);
  });

  it("getJetStream returns a JetStream client after getConnection()", async () => {
    await NatsClient.getConnection();
    const js = NatsClient.getJetStream();
    expect(js).toBeDefined();
  });

  it("close() nullifies the singleton so next getConnection reconnects", async () => {
    await NatsClient.getConnection();
    await NatsClient.close();
    expect(natsConnect).toHaveBeenCalledTimes(1);
    await NatsClient.getConnection();
    expect(natsConnect).toHaveBeenCalledTimes(2);
  });

  it("close() is a no-op when no connection exists", async () => {
    await expect(NatsClient.close()).resolves.toBeUndefined();
  });
});
