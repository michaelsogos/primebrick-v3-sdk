import { describe, it, expect, beforeAll, vi } from "vitest";
import { headers as natsHeaders, type Msg, type NatsConnection, type Subscription } from "nats";
import { makeNatsRoutes, makeNatsRequestRoute, callNats } from "../nats-routes.js";
import { initAuthConfig, loadAuthConfig } from "../../auth/auth-config-cache.js";
import { buildNatsAuthHeaders } from "../../auth/verify-nats.js";
import { AuthMode, type AuthConfig, type AuthUser } from "../../auth/types.js";
import { extJsonStringify } from "../../json/ext-json.js";

const CFG: AuthConfig = {
  mode: AuthMode.GATEWAY,
  roles_path: "roles",
  oidc: {},
  gateway: { secret: "test-secret", secret_header_name: "x-gateway-secret", headers: {} },
  enable_email_verification_check: false,
  enable_webauthn: false,
  passkey_required: false,
  enable_mfa: false,
};

const USER: AuthUser = {
  id: "u-1", idp_code: "casdoor/alice", email: "a@b.c", name: "Alice",
  roles: [], permissions: new Set(["test.do"]), isAdmin: false, isSystem: false,
  idp_org: null, idp_username: null,
};

function fakeMsg(body: unknown, opts: { auth?: boolean; reply?: string } = {}): Msg {
  const h = natsHeaders();
  if (opts.auth !== false) {
    for (const [k, v] of Object.entries(buildNatsAuthHeaders(USER, CFG))) h.set(k, v);
  }
  const responses: Uint8Array[] = [];
  return {
    data: new TextEncoder().encode(extJsonStringify(body)),
    headers: h,
    reply: opts.reply,
    respond: (d?: Uint8Array) => { if (d) responses.push(d); return true; },
    _responses: responses,
    subject: "test.subject",
    sid: 0, seq: 0,
  } as unknown as Msg & { _responses: Uint8Array[] };
}

/** Fake connection: subscribe() returns a controllable queue of msgs. */
function fakeConnection(msgs: Msg[]) {
  const subsOpts: { subject: string; opts?: { queue?: string; max?: number } }[] = [];
  const published: { subject: string; data: Uint8Array; reply?: string }[] = [];
  const conn = {
    subscribe(subject: string, opts?: { queue?: string; max?: number }): Subscription {
      subsOpts.push({ subject, opts });
      const iter = msgs[Symbol.iterator]();
      return {
        [Symbol.asyncIterator]() { return iter as AsyncIterator<Msg>; },
        unsubscribe: () => {},
      } as unknown as Subscription;
    },
    publish(subject: string, data: Uint8Array, opts?: { reply?: string }) {
      published.push({ subject, data, reply: opts?.reply });
    },
  } as unknown as NatsConnection;
  return { conn, subsOpts, published };
}

beforeAll(async () => {
  initAuthConfig({ load: async () => CFG });
  await loadAuthConfig();
});

describe("makeNatsRoutes", () => {
  it("defaults the queue group to the service code", async () => {
    const { conn, subsOpts } = fakeConnection([]);
    await makeNatsRoutes(
      [{ subject: "x.y", permissions: ["test.do"], handler: async () => {} }],
      { serviceCode: "myservice", connection: conn },
    );
    expect(subsOpts[0]).toEqual({ subject: "x.y", opts: { queue: "myservice" } });
  });

  it("queue: null is explicit broadcast (no queue group)", async () => {
    const { conn, subsOpts } = fakeConnection([]);
    await makeNatsRoutes(
      [{ subject: "x.y", queue: null, permissions: ["test.do"], handler: async () => {} }],
      { serviceCode: "myservice", connection: conn },
    );
    expect(subsOpts[0].opts).toBeUndefined();
  });

  it("calls handler for authenticated+authorized messages only", async () => {
    const spy = vi.fn();
    const denied = fakeMsg({ n: 1 }, { auth: false });
    const allowed = fakeMsg({ n: 2 });
    const { conn } = fakeConnection([denied, allowed]);
    await makeNatsRoutes(
      [{ subject: "x.y", permissions: ["test.do"], handler: async ({ request }) => spy(request) }],
      { serviceCode: "svc", connection: conn },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    // extJsonParse is BigInt-safe — integers arrive as bigint
    expect(spy).toHaveBeenCalledWith({ n: 2n });
  });

  it("drops messages failing RBAC", async () => {
    const spy = vi.fn();
    const msg = fakeMsg({ n: 1 }); // USER has only test.do
    const { conn } = fakeConnection([msg]);
    await makeNatsRoutes(
      [{ subject: "x.y", permissions: ["admin.only"], handler: async () => spy() }],
      { serviceCode: "svc", connection: conn },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("makeNatsRequestRoute (correlation reply)", () => {
  it("responds on msg.reply with the handler result", async () => {
    const msg = fakeMsg({ q: "ping" }, { reply: "_INBOX.1" }) as Msg & { _responses: Uint8Array[] };
    const { conn } = fakeConnection([msg]);
    await makeNatsRequestRoute(
      [{ subject: "svc.get", permissions: ["test.do"], handler: async ({ request }) => ({ pong: request }) }],
      { serviceCode: "svc", connection: conn },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(msg._responses).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(msg._responses[0]))).toEqual({ pong: { q: "ping" } });
  });

  it("replies with an error envelope on RBAC denial", async () => {
    const msg = fakeMsg({}, { reply: "_INBOX.2" }) as Msg & { _responses: Uint8Array[] };
    const { conn } = fakeConnection([msg]);
    await makeNatsRequestRoute(
      [{ subject: "svc.get", permissions: ["admin.only"], handler: async () => ({}) }],
      { serviceCode: "svc", connection: conn },
    );
    await new Promise((r) => setTimeout(r, 20));
    const res = JSON.parse(new TextDecoder().decode(msg._responses[0]));
    expect(res.error.code).toBe("RBAC_PERMISSION_DENIED");
  });
});

describe("callNats", () => {
  it("publishes with a private reply inbox and resolves with the response", async () => {
    // fake conn: when the request lands on "svc.get", deliver a reply on the inbox
    let inboxSub: ((msg: Msg) => void) | null = null;
    let publishedReply: string | undefined;
    const conn = {
      subscribe(subject: string): Subscription {
        let nextMsg: Msg | null = null;
        let waiter: ((m: Msg) => void) | null = null;
        if (subject.startsWith("_INBOX")) {
          inboxSub = (m) => (waiter ? waiter(m) : (nextMsg = m));
        }
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              const m = nextMsg ?? (await new Promise<Msg>((r) => (waiter = r)));
              nextMsg = null;
              waiter = null;
              yield m;
            }
          },
          unsubscribe: () => {},
        } as unknown as Subscription;
      },
      publish(_subject: string, _data: Uint8Array, opts?: { reply?: string }) {
        publishedReply = opts?.reply;
        // responder replies on the inbox
        setTimeout(() => {
          inboxSub?.({
            data: new TextEncoder().encode(extJsonStringify({ ok: true })),
            headers: natsHeaders(),
            reply: "",
          } as Msg);
        }, 0);
      },
    } as unknown as NatsConnection;

    const res = await callNats<{ ok: boolean }>("svc.get", { q: 1 }, { connection: conn });
    expect(res).toEqual({ ok: true });
    expect(publishedReply).toMatch(/^_INBOX/);
  });

  it("rejects on responder error envelope", async () => {
    const errMsg = new TextEncoder().encode(extJsonStringify({ error: { code: "RBAC_PERMISSION_DENIED", message: "nope" } }));
    const conn = {
      subscribe: (_s: string, _o?: unknown) => ({
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            next: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: { data: errMsg, headers: natsHeaders(), reply: "" } as Msg }),
          };
        },
        unsubscribe: () => {},
      }) as unknown as Subscription,
      publish: () => {},
    } as unknown as NatsConnection;
    await expect(callNats("svc.get", {}, { connection: conn })).rejects.toThrow("RBAC_PERMISSION_DENIED");
  });
});
