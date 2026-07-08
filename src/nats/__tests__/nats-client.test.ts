import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock functions must be defined via vi.hoisted so they're available when
// the hoisted vi.mock factory runs.
const mocks = vi.hoisted(() => {
  const mockPublish = vi.fn();
  const mockSubscribe = vi.fn();
  const mockClose = vi.fn(async () => {});
  const mockJetstream = vi.fn(() => ({ js: true }));
  const nc = {
    close: mockClose,
    jetstream: mockJetstream,
    publish: mockPublish,
    subscribe: mockSubscribe,
  };
  const mockConnect = vi.fn(async () => nc);
  return { mockPublish, mockSubscribe, mockClose, mockJetstream, mockConnect, nc };
});

vi.mock("nats", () => ({
  connect: mocks.mockConnect,
  NatsConnection: {},
  JetStreamClient: {},
}));

import { NatsClient } from "../nats-client.js";
import { connect as natsConnect } from "nats";
import { extJsonParse, extJsonStringify } from "../../json/ext-json.js";

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

describe("NatsClient.publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    NatsClient.close();
  });

  it("serializes payload with extJsonStringify and publishes as Uint8Array", async () => {
    await NatsClient.getConnection();
    await NatsClient.publish("test.subject", { id: 42n, name: "test" });

    expect(mocks.mockPublish).toHaveBeenCalledTimes(1);
    const [subject, payload] = mocks.mockPublish.mock.calls[0];
    expect(subject).toBe("test.subject");
    expect(payload).toBeInstanceOf(Uint8Array);
    const decoded = extJsonParse(new TextDecoder().decode(payload));
    expect(decoded.id).toBe(42n);
    expect(decoded.name).toBe("test");
  });

  it("serializes bigint values correctly (round-trip)", async () => {
    await NatsClient.getConnection();
    const data = { count: 9007199254740993n, nested: { value: 123n } };
    await NatsClient.publish("bigint.subject", data);

    const payload = mocks.mockPublish.mock.calls[0][1] as Uint8Array;
    const decoded = extJsonParse(new TextDecoder().decode(payload));
    expect(decoded.count).toBe(9007199254740993n);
    expect(decoded.nested.value).toBe(123n);
  });
});

describe("NatsClient.subscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    NatsClient.close();
  });

  it("calls handler with parsed message (bigint preserved)", async () => {
    const handler = vi.fn();
    // Create an async iterable that yields one message then stops
    const testMsg = {
      data: new TextEncoder().encode(extJsonStringify({ id: 99n, action: "create" })),
      reply: "",
      subject: "test.subject",
      sid: 1,
    };
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield testMsg;
      },
    };
    mocks.mockSubscribe.mockReturnValue(asyncIterable);

    await NatsClient.getConnection();
    await NatsClient.subscribe("test.subject", handler);

    // Wait for the async handler to process
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
    const [parsed] = handler.mock.calls[0];
    expect(parsed.id).toBe(99n);
    expect(parsed.action).toBe("create");
  });

  it("handles empty msg.data by calling handler with null", async () => {
    const handler = vi.fn();
    const testMsg = {
      data: new Uint8Array(0),
      reply: "",
      subject: "test.subject",
      sid: 1,
    };
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield testMsg;
      },
    };
    mocks.mockSubscribe.mockReturnValue(asyncIterable);

    await NatsClient.getConnection();
    await NatsClient.subscribe("test.subject", handler);

    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBeNull();
  });
});

describe("NatsClient.subscribeRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    NatsClient.close();
  });

  it("processes request and publishes response to reply subject", async () => {
    const request = { requestId: "req-1", templateCode: "welcome" };
    const response = { requestId: "req-1", success: true };

    const testMsg = {
      data: new TextEncoder().encode(extJsonStringify(request)),
      reply: "reply.subject.123",
      subject: "email.send",
      sid: 1,
    };
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield testMsg;
      },
    };
    mocks.mockSubscribe.mockReturnValue(asyncIterable);

    await NatsClient.getConnection();
    await NatsClient.subscribeRequest(
      "email.send",
      async (req) => {
        expect(req.requestId).toBe("req-1");
        return response;
      },
    );

    await new Promise((resolve) => setImmediate(resolve));

    // Response should be published to the reply subject
    expect(mocks.mockPublish).toHaveBeenCalledTimes(1);
    const [replySubject, payload] = mocks.mockPublish.mock.calls[0];
    expect(replySubject).toBe("reply.subject.123");
    const decoded = extJsonParse(new TextDecoder().decode(payload));
    expect(decoded.success).toBe(true);
    expect(decoded.requestId).toBe("req-1");
  });

  it("includes requestId in error response when handler throws", async () => {
    const request = { requestId: "req-err", templateCode: "welcome" };

    const testMsg = {
      data: new TextEncoder().encode(extJsonStringify(request)),
      reply: "reply.subject.err",
      subject: "email.send",
      sid: 1,
    };
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield testMsg;
      },
    };
    mocks.mockSubscribe.mockReturnValue(asyncIterable);

    await NatsClient.getConnection();
    await NatsClient.subscribeRequest(
      "email.send",
      async () => {
        throw new Error("Handler failed");
      },
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.mockPublish).toHaveBeenCalledTimes(1);
    const [replySubject, payload] = mocks.mockPublish.mock.calls[0];
    expect(replySubject).toBe("reply.subject.err");
    const decoded = extJsonParse(new TextDecoder().decode(payload));
    expect(decoded.success).toBe(false);
    expect(decoded.error).toBe("Handler failed");
    expect(decoded.requestId).toBe("req-err");
  });
});
