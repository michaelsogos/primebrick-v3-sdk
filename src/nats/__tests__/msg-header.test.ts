import { describe, it, expect } from "vitest";
import { headers } from "nats"; // REAL nats.js headers — not a mock
import { msgHeader } from "../msg-headers.js";

describe("msgHeader", () => {
  it("real nats.js MsgHdrs is case-sensitive (regression guard)", () => {
    // This test documents the actual library behaviour the helper exists for.
    const h = headers();
    h.set("User-Agent", "svc/1.0.0");
    expect(h.get("user-agent")).toBeFalsy(); // raw get misses lowercase lookup
    expect(h.get("User-Agent")).toBe("svc/1.0.0");
  });

  it("reads lowercase and canonical forms", () => {
    const h = headers();
    h.set("User-Agent", "primebrick-ai/0.6.0");
    h.set("x-primebrick-client-shield-key", "k");
    expect(msgHeader(h, "user-agent")).toBe("primebrick-ai/0.6.0");
    expect(msgHeader(h, "User-Agent")).toBe("primebrick-ai/0.6.0");
    expect(msgHeader(h, "x-primebrick-client-shield-key")).toBe("k");
    expect(msgHeader(h, "X-Primebrick-Client-Shield-Key")).toBe("k");
  });

  it("returns null for missing headers and undefined hdrs", () => {
    const h = headers();
    expect(msgHeader(h, "nope")).toBeNull();
    expect(msgHeader(undefined, "user-agent")).toBeNull();
  });
});
