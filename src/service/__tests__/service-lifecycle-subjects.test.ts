import { describe, it, expect } from "vitest";
import { SERVICE_SUBJECTS } from "../service-lifecycle-subjects.js";
import { extJsonStringify, extJsonParse } from "../../json/ext-json.js";

describe("SERVICE_SUBJECTS", () => {
  it("exposes stable subject strings", () => {
    expect(SERVICE_SUBJECTS.REGISTER).toBe("service.register");
    expect(SERVICE_SUBJECTS.HEARTBEAT).toBe("service.heartbeat");
    expect(SERVICE_SUBJECTS.UNREGISTER).toBe("service.unregister");
  });
});

describe("ServiceHeartbeatPayload serialization", () => {
  it("round-trips through extJsonStringify/parse preserving all fields", () => {
    const payload = {
      code: "EMAILSENDER",
      base_url: "http://localhost:3003",
      service_version: "1.2.3",
      name: "Email Sender",
      description: "Sends emails",
      author: "PrimeBrick",
      github_repo_url: "https://github.com/primebrick/emailsender",
      is_behind_scaler: false,
      http_healthy: true,
      nats_connected: true,
      checks: {
        db: { ok: true },
        nats: { ok: true },
      },
    };
    const json = extJsonStringify(payload);
    const parsed = extJsonParse<typeof payload>(json);
    expect(parsed).toEqual(payload);
  });

  it("round-trips with bigint values in checks", () => {
    const payload = {
      code: "EMAILSENDER",
      base_url: "http://localhost:3003",
      is_behind_scaler: true,
      http_healthy: true,
      nats_connected: true,
      checks: {
        db: { ok: true, latency_ms: 42n },
      },
    };
    const json = extJsonStringify(payload);
    const parsed = extJsonParse<typeof payload>(json);
    expect(parsed.checks.db.latency_ms).toBe(42n);
    expect(typeof parsed.checks.db.latency_ms).toBe("bigint");
  });
});
