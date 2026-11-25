import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock functions must be defined via vi.hoisted so they're available when
// the hoisted vi.mock factory runs.
const mocks = vi.hoisted(() => {
  const mockPublish = vi.fn();
  const mockSubscribe = vi.fn();
  const mockClose = vi.fn(async () => {});
  const mockJsPublish = vi.fn(async () => ({ seq: 42 }));
  const mockJetstream = vi.fn(() => ({ publish: mockJsPublish }));
  const mockJetstreamManager = vi.fn(async () => ({ jsm: true }));
  const mockRequest = vi.fn(async () => ({ data: new Uint8Array(0) }));
  const nc = {
    close: mockClose,
    isClosed: vi.fn(() => false),
    publish: mockPublish,
    subscribe: mockSubscribe,
    request: mockRequest,
  };
  const mockConnect = vi.fn(async () => nc);
  return { mockPublish, mockSubscribe, mockClose, mockJsPublish, mockJetstream, mockJetstreamManager, mockRequest, mockConnect, nc };
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
import { connect as natsConnect } from "@nats-io/transport-node";
import { extJsonParse, extJsonStringify } from "../../json/ext-json.js";
import { isEnvelope, openEnvelope } from "../message-envelope.js";
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

  it("falls back to legacy plaintext before the key provider is wired, warning once", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await NatsClient.getConnection();
    await NatsClient.publishEphemeralLossy("legacy.subject", { secret_field: "plaintext-value" }, { "x-user-id": "user-123" });
    await NatsClient.publishEphemeralLossy("legacy.subject", { secret_field: "plaintext-value" }, { "x-user-id": "user-123" });

    const [, payload, opts] = mocks.mockPublish.mock.calls[0];
    const wireText = new TextDecoder().decode(payload);
    expect(wireText).toContain("plaintext-value");
    expect(opts.headers.get("x-user-id")).toBe("user-123");
    const keyWarnings = warnSpy.mock.calls.filter(([msg]) => typeof msg === "string" && msg.includes("MESSAGE_KEY_UNAVAILABLE"));
    expect(keyWarnings).toHaveLength(1);
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

  it("serializes payload with extJsonStringify and publishes as Uint8Array", async () => {
    await NatsClient.getConnection();
    await NatsClient.publishEphemeralLossy("test.subject", { id: 42n, name: "test" });

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
    await NatsClient.publishEphemeralLossy("bigint.subject", data);

    const payload = mocks.mockPublish.mock.calls[0][1] as Uint8Array;
    const decoded = extJsonParse(new TextDecoder().decode(payload));
    expect(decoded.count).toBe(9007199254740993n);
    expect(decoded.nested.value).toBe(123n);
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

describe("NatsClient.subscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMessageKeyProvider(null);
    resetAuthConfigForTest();
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

