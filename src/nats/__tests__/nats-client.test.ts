import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock functions must be defined via vi.hoisted so they're available when
// the hoisted vi.mock factory runs.
const mocks = vi.hoisted(() => {
  const mockPublish = vi.fn();
  const mockSubscribe = vi.fn();
  const mockClose = vi.fn(async () => {});
  const mockJsPublish = vi.fn(async () => ({ seq: 42 }));
  const mockConsumersAdd = vi.fn(async () => ({}));
  const mockConsumerFetch = vi.fn();
  const mockConsumersGet = vi.fn(async () => ({ fetch: mockConsumerFetch }));
  const mockJetstream = vi.fn(() => ({ publish: mockJsPublish, consumers: { get: mockConsumersGet } }));
  const mockJetstreamManager = vi.fn(async () => ({ consumers: { add: mockConsumersAdd } }));
  const mockRequest = vi.fn(async () => ({ data: new Uint8Array(0) }));
  const nc = {
    close: mockClose,
    isClosed: vi.fn(() => false),
    publish: mockPublish,
    subscribe: mockSubscribe,
    request: mockRequest,
  };
  const mockConnect = vi.fn(async () => nc);
  return { mockPublish, mockSubscribe, mockClose, mockJsPublish, mockConsumersAdd, mockConsumerFetch, mockConsumersGet, mockJetstream, mockJetstreamManager, mockRequest, mockConnect, nc };
});

vi.mock("@nats-io/transport-node", () => ({
  connect: mocks.mockConnect,
  // MsgHdrs stand-in faithful to real nats.js: CASE-SENSITIVE verbatim
  // get/set. A previous version normalized keys to lowercase, masking the
  // real library's behaviour — that is the exact bug this must not hide.
  headers: () => {
    const map = new Map<string, string[]>();
    return {
      get: (k: string) => map.get(k)?.[0],
      set: (k: string, v: string) => map.set(k, [v]),
      append: (k: string, v: string) => map.set(k, [...(map.get(k) ?? []), v]),
      keys: () => [...map.keys()],
      delete: (k: string) => map.delete(k),
      [Symbol.iterator]: function* () {
        yield* map.entries();
      },
    };
  },
}));

// Keep the real module for AckPolicy/JetStreamApiError; only the two
// client factories are faked (v3: standalone functions, not nc methods).
vi.mock("@nats-io/jetstream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nats-io/jetstream")>();
  return {
    ...actual,
    jetstream: mocks.mockJetstream,
    jetstreamManager: mocks.mockJetstreamManager,
  };
});

import { NatsClient } from "../nats-client.js";
import { connect as natsConnect, headers as natsHeaders } from "@nats-io/transport-node";
import { extJsonParse, extJsonStringify } from "../../json/ext-json.js";
import { isEnvelope, openEnvelope, sealEnvelope } from "../message-envelope.js";
import { MessageKeyProvider, setMessageKeyProvider } from "../message-key-provider.js";
import { serializeAuthUserToHeaders } from "../../auth/auth-user-serializer.js";
import { initAuthConfig, loadAuthConfig, resetAuthConfigForTest } from "../../auth/auth-config-cache.js";
import { AuthMode, type AuthConfig, type AuthUser } from "../../auth/types.js";
import { logger } from "../../lifecycle/logger.js";

async function readyProvider(): Promise<MessageKeyProvider> {
  const provider = new MessageKeyProvider(async () => ({
    generation: 7,
    generations: { "7": "test-partb-material" },
  }));
  await provider.refresh();
  return provider;
}

function resetPlaintextWarningForTest(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("primebrick.sdk.message-key-plaintext-warned")];
}

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

describe("NatsClient.publishEphemeralLossy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMessageKeyProvider(null);
    resetAuthConfigForTest();
    resetPlaintextWarningForTest();
    NatsClient.close();
  });

  it("fail-closed without key provider: publish throws, nothing reaches the wire", async () => {
    await NatsClient.getConnection();
    await expect(
      NatsClient.publishEphemeralLossy("legacy.subject", { secret_field: "plaintext-value" }),
    ).rejects.toThrow("MESSAGE_KEY_PROVIDER_UNAVAILABLE");
    expect(mocks.mockPublish).not.toHaveBeenCalled();
  });

  it("seals payload and sensitive x-user headers when the key provider is ready", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    await NatsClient.getConnection();
    await NatsClient.publishEphemeralLossy(
      "encrypted.subject",
      { secret_field: "topsecret-value", count: 42n },
      { "x-user-id": "user-123", "X-User-Email": "user@example.com", "x-job-run-id": "run-1" },
    );

    const [, payload, opts] = mocks.mockPublish.mock.calls[0];
    const wireText = new TextDecoder().decode(payload);
    expect(wireText).not.toContain("topsecret-value");
    expect(wireText).not.toContain("secret_field");
    expect(wireText).not.toContain("user-123");
    expect(wireText).not.toContain("user@example.com");
    expect(opts.headers.get("x-user-id")).toBeUndefined();
    expect(opts.headers.get("X-User-Email")).toBeUndefined();
    expect(opts.headers.get("x-job-run-id")).toBe("run-1");

    const parsed = extJsonParse(wireText);
    expect(isEnvelope(parsed)).toBe(true);
    const opened = openEnvelope(parsed as never, (generation) => provider.keyForGeneration(generation));
    expect(opened.payload).toEqual({ secret_field: "topsecret-value", count: 42n });
    expect(opened.headers).toEqual({ "x-user-id": "user-123", "X-User-Email": "user@example.com" });
  });

  it("seals configured auth-user header names while shield stamps stay transport-visible", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    const config: AuthConfig = {
      mode: AuthMode.GATEWAY,
      roles_path: "roles",
      oidc: {},
      gateway: {
        secret: "shield-secret",
        secret_header_name: "x-client-shield-secret",
        headers: { user_id: "auth-principal", permissions: "auth-permissions" },
      },
      enable_email_verification_check: false,
      enable_webauthn: false,
      passkey_required: false,
      enable_mfa: false,
    };
    initAuthConfig({ load: async () => config });
    await loadAuthConfig();
    const user: AuthUser = {
      id: "user-custom",
      idp_code: "idp-subject",
      email: null,
      name: null,
      roles: [],
      permissions: new Set(["test.permission"]),
      isAdmin: false,
      isSystem: false,
      idp_org: null,
      idp_username: null,
    };
    const authHeaders = serializeAuthUserToHeaders(user, config);

    await NatsClient.getConnection();
    await NatsClient.publishEphemeralLossy("encrypted.custom-headers", { ok: true }, authHeaders);

    const [, payload, opts] = mocks.mockPublish.mock.calls[0];
    expect(opts.headers.get("auth-principal")).toBeUndefined();
    expect(opts.headers.get("auth-permissions")).toBeUndefined();
    expect(opts.headers.get("x-client-shield-secret")).toBe("shield-secret");
    const opened = openEnvelope(extJsonParse(new TextDecoder().decode(payload)) as never, (generation) =>
      provider.keyForGeneration(generation),
    );
    expect((opened.headers as Record<string, string>)["auth-principal"]).toBe("user-custom");
    expect((opened.headers as Record<string, string>)["auth-permissions"]).toBe("test.permission");
  });

  it("serializes payload with extJsonStringify inside the sealed envelope", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    await NatsClient.getConnection();
    await NatsClient.publishEphemeralLossy("test.subject", { id: 42n, name: "test" });
    expect(mocks.mockPublish).toHaveBeenCalledTimes(1);
    const [subject, payload] = mocks.mockPublish.mock.calls[0];
    expect(subject).toBe("test.subject");
    expect(payload).toBeInstanceOf(Uint8Array);
    const opened = openEnvelope(extJsonParse(new TextDecoder().decode(payload)) as never, (g) => provider.keyForGeneration(g));
    expect((opened.payload as { id: bigint }).id).toBe(42n);
    expect((opened.payload as { name: string }).name).toBe("test");
  });

  it("serializes bigint values correctly inside the sealed envelope (round-trip)", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    await NatsClient.getConnection();
    const data = { count: 9007199254740993n, nested: { value: 123n } };
    await NatsClient.publishEphemeralLossy("bigint.subject", data);
    const payload = mocks.mockPublish.mock.calls[0][1] as Uint8Array;
    const opened = openEnvelope(extJsonParse(new TextDecoder().decode(payload)) as never, (g) => provider.keyForGeneration(g));
    expect((opened.payload as typeof data).count).toBe(9007199254740993n);
    expect((opened.payload as typeof data).nested.value).toBe(123n);
  });
});

describe("NatsClient.publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMessageKeyProvider(null);
    resetAuthConfigForTest();
    NatsClient.close();
  });

  it("seals durable JetStream publishes with the current generation and returns the stream sequence", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    await NatsClient.getConnection();
    const seq = await NatsClient.publish(
      "durable.subject",
      { secret_field: "durable-secret", entity_id: 99n },
      { "x-user-id": "user-456", "x-job-run-id": "run-2" },
    );

    expect(seq).toBe(42n);
    expect(mocks.mockJsPublish).toHaveBeenCalledTimes(1);
    const [subject, payload, opts] = mocks.mockJsPublish.mock.calls[0];
    expect(subject).toBe("durable.subject");
    const wireText = new TextDecoder().decode(payload);
    expect(wireText).not.toContain("durable-secret");
    expect(wireText).not.toContain("user-456");
    expect(opts.headers.get("x-user-id")).toBeUndefined();
    expect(opts.headers.get("x-job-run-id")).toBe("run-2");

    const parsed = extJsonParse(wireText);
    expect(isEnvelope(parsed)).toBe(true);
    const opened = openEnvelope(parsed as never, (generation) => provider.keyForGeneration(generation));
    expect(opened.payload).toEqual({ secret_field: "durable-secret", entity_id: 99n });
    expect(opened.headers).toEqual({ "x-user-id": "user-456" });
  });
});

describe("NatsClient.jetstreamSubscribe encryption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMessageKeyProvider(null);
    resetAuthConfigForTest();
    mocks.mockConsumerFetch.mockReset();
    NatsClient.close();
  });

  function fakeJsMsg(data: Uint8Array, hdrs?: ReturnType<typeof natsHeaders>) {
    return {
      subject: "durable.subject",
      data,
      headers: hdrs,
      seq: 77,
      info: { deliveryCount: 0 },
      working: vi.fn(),
      ack: vi.fn(),
      nak: vi.fn(),
      term: vi.fn(),
    };
  }

  function endlessAfterFirst(first: ReturnType<typeof fakeJsMsg>) {
    mocks.mockConsumerFetch
      .mockImplementationOnce(async () => ({
        async *[Symbol.asyncIterator]() { yield first; },
      }))
      .mockImplementation(async () => new Promise(() => {}));
  }

  it("opens durable payloads before verify/handler and merges sealed auth headers", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    const current = provider.currentKey();
    expect(current).not.toBeNull();
    const outer = natsHeaders();
    outer.set("traceparent", "00-test-trace");
    const wire = sealEnvelope(current!.key, current!.generation, { durable_secret: "sealed-durable" }, { "x-user-id": "user-js" });
    const msg = fakeJsMsg(new TextEncoder().encode(wire), outer);
    endlessAfterFirst(msg);
    const handler = vi.fn(async () => {});
    const verify = vi.fn(async () => undefined);

    await NatsClient.getConnection();
    const handle = await NatsClient.jetstreamSubscribe({
      stream: "SVC",
      durable: "svc-durable",
      filterSubject: "durable.subject",
      verify,
      handler,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.close();

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0].headers.get("x-user-id")).toBe("user-js");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({ durable_secret: "sealed-durable" });
    expect(handler.mock.calls[0][1].headers.get("x-user-id")).toBe("user-js");
    expect(handler.mock.calls[0][1].headers.get("traceparent")).toBe("00-test-trace");
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("terminates tampered durable ciphertext without delivering it", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    const current = provider.currentKey();
    expect(current).not.toBeNull();
    const wire = extJsonParse(sealEnvelope(current!.key, current!.generation, { durable_secret: "sealed-durable" }, {})) as {
      enc: number;
      gen: number;
      iv: string;
      data: string;
    };
    wire.data = wire.data.slice(0, 4) + (wire.data[4] === "A" ? "B" : "A") + wire.data.slice(5);
    const msg = fakeJsMsg(new TextEncoder().encode(extJsonStringify(wire)));
    endlessAfterFirst(msg);
    const handler = vi.fn(async () => {});
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    await NatsClient.getConnection();
    const handle = await NatsClient.jetstreamSubscribe({
      stream: "SVC",
      durable: "svc-durable",
      filterSubject: "durable.subject",
      handler,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.close();

    expect(handler).not.toHaveBeenCalled();
    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();

    // Security evidence: the term()+return path bypasses the outer error
    // logger, so the violation MUST surface as its own structured security
    // event — metadata only, never payload/ciphertext material.
    const securityLogs = errorSpy.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("terminal message rejection"),
    );
    expect(securityLogs).toHaveLength(1);
    const meta = securityLogs[0][1] as Record<string, unknown>;
    expect(meta.security_event).toBe("nats_message_integrity_violation");
    expect(meta.error_code).toBe("MESSAGE_INTEGRITY_VIOLATION");
    expect(meta.stream).toBe("SVC");
    expect(meta.durable).toBe("svc-durable");
    expect(meta.stream_sequence).toBe(77);
    expect(meta.key_generation).toBe(Number(current!.generation));
    expect(meta.subject).toBe("durable.subject");
    expect(meta.tags).toEqual(expect.arrayContaining(["nats", "security"]));
    const serializedMeta = extJsonStringify(meta);
    expect(serializedMeta).not.toContain("sealed-durable");
    expect(serializedMeta).not.toContain("durable_secret");
    errorSpy.mockRestore();
  });
});

describe("NatsClient.subscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMessageKeyProvider(null);
    resetAuthConfigForTest();
    NatsClient.close();
  });

  it("calls handler with parsed message (bigint preserved)", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    const key = await provider.currentKey();
    const handler = vi.fn();
    const wire = sealEnvelope(key.key, key.generation, { id: 99n, action: "create" }, {});
    const testMsg = {
      data: new TextEncoder().encode(wire),
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

  it("opens encrypted messages before the handler and merges sensitive headers", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    const current = provider.currentKey();
    expect(current).not.toBeNull();
    const outerHeaders = natsHeaders();
    outerHeaders.set("x-job-run-id", "run-9");
    const wire = sealEnvelope(current!.key, current!.generation, { secret_field: "sealed-value" }, { "x-user-id": "user-999" });
    const handler = vi.fn();
    const testMsg = {
      data: new TextEncoder().encode(wire),
      headers: outerHeaders,
      reply: "",
      subject: "test.subject",
      sid: 1,
    };
    mocks.mockSubscribe.mockReturnValue({
      async *[Symbol.asyncIterator]() { yield testMsg; },
    });

    await NatsClient.getConnection();
    await NatsClient.subscribe("test.subject", handler);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
    const [data, raw] = handler.mock.calls[0];
    expect(data).toEqual({ secret_field: "sealed-value" });
    expect(raw.headers.get("x-user-id")).toBe("user-999");
    expect(raw.headers.get("x-job-run-id")).toBe("run-9");
  });

  it("passes a closed decrypted view to the handler — ciphertext unreachable through it", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    const current = provider.currentKey();
    expect(current).not.toBeNull();
    const wire = sealEnvelope(current!.key, current!.generation, { secret_field: "sealed-value" }, { "x-user-id": "user-view" });
    const respond = vi.fn(() => true);
    const testMsg = {
      data: new TextEncoder().encode(wire),
      headers: natsHeaders(),
      reply: "reply.subject",
      subject: "test.subject",
      sid: 1,
      respond,
    };
    const handler = vi.fn();
    mocks.mockSubscribe.mockReturnValue({
      async *[Symbol.asyncIterator]() { yield testMsg; },
    });

    await NatsClient.getConnection();
    await NatsClient.subscribe("test.subject", handler);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
    const [, view] = handler.mock.calls[0] as [unknown, {
      data: Uint8Array;
      string: () => string;
      respond: () => boolean;
      subject: string;
      reply: string;
    }];
    expect(extJsonParse(new TextDecoder().decode(view.data))).toEqual({ secret_field: "sealed-value" });
    expect(view.string()).not.toBe(wire);
    view.respond();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(view.subject).toBe("test.subject");
    expect(view.reply).toBe("reply.subject");
  });

  it("never delivers a tampered encrypted message to the handler", async () => {
    const provider = await readyProvider();
    setMessageKeyProvider(provider);
    const current = provider.currentKey();
    expect(current).not.toBeNull();
    const wire = extJsonParse(sealEnvelope(current!.key, current!.generation, { secret_field: "sealed-value" }, {})) as {
      enc: number;
      gen: number;
      iv: string;
      data: string;
    };
    wire.data = wire.data.slice(0, 4) + (wire.data[4] === "A" ? "B" : "A") + wire.data.slice(5);
    const handler = vi.fn();
    mocks.mockSubscribe.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { data: new TextEncoder().encode(extJsonStringify(wire)), reply: "", subject: "test.subject", sid: 1 };
      },
    });

    await NatsClient.getConnection();
    await NatsClient.subscribe("test.subject", handler);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).not.toHaveBeenCalled();
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

