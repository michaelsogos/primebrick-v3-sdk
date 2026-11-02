import { describe, it, expect } from "vitest";
import { validateCallablesDeclaration } from "../callables-declaration.js";
import { recordCallable, snapshotCallables } from "../../nats/callable-registry.js";
import { makeNatsRoutes, makeNatsRequestRoute } from "../../nats/nats-routes.js";
import { initAuthConfig, loadAuthConfig } from "../../auth/auth-config-cache.js";
import { AuthMode, type AuthConfig } from "../../auth/types.js";
import type { Msg, NatsConnection, Subscription } from "@nats-io/transport-node";

const CFG: AuthConfig = {
  mode: AuthMode.GATEWAY,
  roles_path: "roles",
  oidc: {},
  gateway: { secret: "test-secret", secret_header_name: "x-client-shield-secret", headers: {} },
  enable_email_verification_check: false,
  enable_webauthn: false,
  passkey_required: false,
  enable_mfa: false,
};

initAuthConfig({ load: async () => CFG });
await loadAuthConfig();

function fakeConnection(): NatsConnection {
  return {
    subscribe(subject: string): Subscription {
      const iter = ([] as Msg[])[Symbol.iterator]();
      return {
        [Symbol.asyncIterator]() { return iter as AsyncIterator<Msg>; },
        unsubscribe: () => {},
      } as unknown as Subscription;
    },
    publish() {},
  } as unknown as NatsConnection;
}

const SCHEMA = { type: "object", properties: { x: { type: "string" } } };

describe("validateCallablesDeclaration", () => {
  it("accepts undefined/absent (optional axis)", () => {
    expect(validateCallablesDeclaration("svc", undefined)).toBeNull();
    expect(validateCallablesDeclaration("svc", {})).toBeNull();
    expect(validateCallablesDeclaration("svc", { callables: [] })).toBeNull();
  });

  it("accepts a well-formed declaration", () => {
    expect(
      validateCallablesDeclaration("svc", {
        callables: [
          {
            subject: "svc.do_thing",
            kind: "pub",
            permissions: ["svc.do"],
            payload_schema: SCHEMA,
            label_key: "svc.callable.do.label",
            description_key: "svc.callable.do.desc",
          },
        ],
      }),
    ).toBeNull();
  });

  it("requires payload_schema — a callable without a contract is not mappable", () => {
    expect(
      validateCallablesDeclaration("svc", { callables: [{ subject: "svc.x", kind: "pub" }] }),
    ).toMatch(/payload_schema is REQUIRED/);
  });

  it("rejects wildcard subjects — destinations are concrete", () => {
    for (const subject of ["svc.*", "svc.>", "svc.*.send"]) {
      expect(
        validateCallablesDeclaration("svc", {
          callables: [{ subject, kind: "pub", payload_schema: SCHEMA }],
        }),
      ).toMatch(/wildcards are not callable/);
    }
  });

  it("rejects unknown kind, duplicate subjects and unknown keys", () => {
    expect(
      validateCallablesDeclaration("svc", {
        callables: [{ subject: "svc.x", kind: "rpc", payload_schema: SCHEMA }],
      }),
    ).toMatch(/kind must be "pub" or "request"/);
    expect(
      validateCallablesDeclaration("svc", {
        callables: [
          { subject: "svc.x", kind: "pub", payload_schema: SCHEMA },
          { subject: "svc.x", kind: "pub", payload_schema: SCHEMA },
        ],
      }),
    ).toMatch(/duplicate subject/);
    expect(
      validateCallablesDeclaration("svc", {
        callables: [{ subject: "svc.x", kind: "pub", payload_schema: SCHEMA, due: true }],
      }),
    ).toMatch(/unknown key/);
  });
});

describe("callable registry — route-declaration census", () => {
  it("makeNatsRoutes records only routes carrying payload_schema", async () => {
    const before = snapshotCallables().length;
    await makeNatsRoutes(
      [
        { subject: "test.no_contract", permissions: ["t.p"], handler: async () => {} },
        {
          subject: "test.with_contract",
          permissions: ["t.p"],
          payload_schema: SCHEMA,
          label_key: "t.with_contract.label",
          handler: async () => {},
        },
      ],
      { serviceCode: "svc", connection: fakeConnection() },
    );
    const entries = snapshotCallables().slice(before);
    expect(entries.map((c) => c.subject)).toEqual(["test.with_contract"]);
    expect(entries[0]!.kind).toBe("pub");
    expect(entries[0]!.label_key).toBe("t.with_contract.label");
  });

  it("makeNatsRequestRoute records with kind 'request'", async () => {
    const before = snapshotCallables().length;
    await makeNatsRequestRoute(
      [
        {
          subject: "test.request_call",
          permissions: ["t.p"],
          payload_schema: SCHEMA,
          handler: async () => ({}),
        },
      ],
      { serviceCode: "svc", connection: fakeConnection() },
    );
    const entries = snapshotCallables().slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("request");
  });

  it("recordCallable is idempotent per subject (re-subscription replaces)", () => {
    recordCallable({ subject: "test.dedup", kind: "pub", payload_schema: SCHEMA });
    recordCallable({ subject: "test.dedup", kind: "pub", payload_schema: { type: "object" } });
    const matches = snapshotCallables().filter((c) => c.subject === "test.dedup");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.payload_schema).toEqual({ type: "object" });
  });
});

describe("x_* annotation vocabulary (closed set)", () => {
  const base = {
    subject: "svc.do_thing",
    kind: "pub",
    permissions: ["svc.do"],
    payload_schema: { type: "object", properties: {} },
    label_key: "svc.callable.do.label",
    description_key: "svc.callable.do.desc",
  };
  const withProp = (prop: Record<string, unknown>) => ({
    callables: [
      {
        ...base,
        payload_schema: { type: "object", properties: { f: { type: "string", ...prop } } },
      },
    ],
  });

  it("accepts a fully annotated property", () => {
    expect(
      validateCallablesDeclaration("svc", {
        callables: [
          {
            ...base,
            payload_schema: {
              type: "object",
              properties: {
                requestId: { type: "string", x_inject: "uuid", x_not_editable: true },
                entityUuid: { type: "string", x_semantic: "entity.uuid" },
                templateCode: {
                  type: "string",
                  x_options: { api_url: "/x/list", api_verb: "GET", value_field: "code", label_field: "subject" },
                },
                languageIso: { type: "string", x_options: { values_source: "locales" } },
                variables: { type: "object", x_map_keys: { from: "templateCode", prop: "variables" } },
              },
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects an unknown injector", () => {
    expect(validateCallablesDeclaration("svc", withProp({ x_inject: "magic" }))).toMatch(/x_inject/);
  });
  it("rejects non-boolean x_not_editable", () => {
    expect(validateCallablesDeclaration("svc", withProp({ x_not_editable: "yes" }))).toMatch(
      /x_not_editable/,
    );
  });
  it("rejects an unknown semantic slot", () => {
    expect(validateCallablesDeclaration("svc", withProp({ x_semantic: "entity.title" }))).toMatch(
      /x_semantic/,
    );
  });
  it("rejects malformed x_options", () => {
    expect(validateCallablesDeclaration("svc", withProp({ x_options: "url" }))).toMatch(/x_options/);
    expect(validateCallablesDeclaration("svc", withProp({ x_options: {} }))).toMatch(/x_options/);
    expect(
      validateCallablesDeclaration("svc", withProp({ x_options: { api_url: 42 } })),
    ).toMatch(/x_options/);
    expect(
      validateCallablesDeclaration("svc", withProp({ x_options: { api_url: "/x", bogus: 1 } })),
    ).toMatch(/x_options/);
  });
  it("rejects malformed x_map_keys", () => {
    expect(validateCallablesDeclaration("svc", withProp({ x_map_keys: "t" }))).toMatch(/x_map_keys/);
    expect(validateCallablesDeclaration("svc", withProp({ x_map_keys: { from: 1 } }))).toMatch(
      /x_map_keys/,
    );
  });

  it("required + x_not_editable needs x_inject or x_semantic — a hidden required field must declare its source", () => {
    const hidden = (annotations: Record<string, unknown>) => ({
      callables: [
        {
          ...base,
          payload_schema: {
            type: "object",
            required: ["f"],
            properties: { f: { type: "string", x_not_editable: true, ...annotations } },
          },
        },
      ],
    });
    expect(validateCallablesDeclaration("svc", hidden({}))).toMatch(/x_inject or x_semantic/);
    expect(validateCallablesDeclaration("svc", hidden({ x_inject: "uuid" }))).toBeNull();
    expect(validateCallablesDeclaration("svc", hidden({ x_semantic: "entity.uuid" }))).toBeNull();
    // not required → the rule does not apply
    expect(validateCallablesDeclaration("svc", withProp({ x_not_editable: true }))).toBeNull();
  });

  it("x_options api_url requires explicit verb/value_field/label_field — no silent defaults", () => {
    expect(
      validateCallablesDeclaration("svc", withProp({ x_options: { api_url: "/x" } })),
    ).toMatch(/x_options\.api_verb/);
    expect(
      validateCallablesDeclaration(
        "svc",
        withProp({ x_options: { api_url: "/x", api_verb: "GET" } }),
      ),
    ).toMatch(/x_options\.value_field/);
    expect(
      validateCallablesDeclaration(
        "svc",
        withProp({ x_options: { api_url: "/x", api_verb: "GET", value_field: "code" } }),
      ),
    ).toMatch(/x_options\.label_field/);
  });

  it("x_options values_source is a closed registry", () => {
    expect(
      validateCallablesDeclaration("svc", withProp({ x_options: { values_source: "locales" } })),
    ).toBeNull();
    expect(
      validateCallablesDeclaration("svc", withProp({ x_options: { values_source: "anything" } })),
    ).toMatch(/values_source must be one of/);
  });
});
