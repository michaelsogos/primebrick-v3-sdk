import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  sealEnvelope,
  openEnvelope,
  isEnvelope,
  MessageIntegrityViolationError,
  MessageKeyUnknownError,
} from "../message-envelope.js";
import { deriveMessageKey, MessageKeyProvider, MESSAGE_KEY_PART_A } from "../message-key-provider.js";
import { extJsonParse } from "../../json/ext-json.js";

const testKey = (gen: number) => deriveMessageKey(MESSAGE_KEY_PART_A, "test-partb-material", gen);

describe("message-envelope", () => {
  it("roundtrips payload + sensitive headers through seal/open", () => {
    const key = testKey(1);
    const payload = { requestId: "req-1", amount: 42n, nested: { list: [1, 2, 3] } };
    const headers = { "x-user-id": "u-1", "x-user-roles": "admin" };
    const wire = sealEnvelope(key, 1, payload, headers);
    const parsed = extJsonParse(wire) as Record<string, unknown>;
    expect(isEnvelope(parsed)).toBe(true);
    const opened = openEnvelope(parsed as never, () => key);
    // ext-json wire contract: integer-valued numbers materialize as bigint —
    // the roundtrip expectation follows the codec, not the literal input shape.
    expect(opened.payload).toEqual({ requestId: "req-1", amount: 42n, nested: { list: [1n, 2n, 3n] } });
    expect(opened.headers).toEqual(headers);
  });

  it("wire format is opaque — no payload or user-header content leaks in cleartext", () => {
    const wire = sealEnvelope(testKey(1), 1, { secret_field: "topsecret-value" }, { "x-user-id": "user-123" });
    expect(wire).not.toContain("topsecret-value");
    expect(wire).not.toContain("secret_field");
    expect(wire).not.toContain("user-123");
    expect(wire).not.toContain("x-user-id");
  });

  it("bit-flipped ciphertext is rejected as integrity violation, never delivered", () => {
    const key = testKey(1);
    const wire = sealEnvelope(key, 1, { a: 1 }, {});
    const parsed = extJsonParse(wire) as { enc: number; gen: number; iv: string; data: string };
    const raw = Buffer.from(parsed.data, "base64url");
    raw[0] = raw[0] ^ 0xff; // tamper first ciphertext byte
    parsed.data = raw.toString("base64url");
    expect(() => openEnvelope(parsed as never, () => key)).toThrow(MessageIntegrityViolationError);
  });

  it("bit-flipped auth tag is rejected as integrity violation", () => {
    const key = testKey(1);
    const wire = sealEnvelope(key, 1, { a: 1 }, {});
    const parsed = extJsonParse(wire) as { enc: number; gen: number; iv: string; data: string };
    const raw = Buffer.from(parsed.data, "base64url");
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff; // tamper last tag byte
    parsed.data = raw.toString("base64url");
    expect(() => openEnvelope(parsed as never, () => key)).toThrow(MessageIntegrityViolationError);
  });

  it("wrong key is rejected — cross-generation ciphertext is undecryptable", () => {
    const wire = sealEnvelope(testKey(1), 1, { a: 1 }, {});
    const parsed = extJsonParse(wire) as never;
    expect(() => openEnvelope(parsed, () => testKey(2))).toThrow(MessageIntegrityViolationError);
  });

  it("unknown generation is rejected distinctly from tampering", () => {
    const wire = sealEnvelope(testKey(1), 1, { a: 1 }, {});
    const parsed = extJsonParse(wire) as never;
    expect(() => openEnvelope(parsed, () => null)).toThrow(MessageKeyUnknownError);
  });

  it("legacy plaintext objects are not envelopes (transition detection)", () => {
    expect(isEnvelope({ hello: "world" })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({ enc: 1 })).toBe(false); // missing gen/iv/data
    expect(isEnvelope("string")).toBe(false);
  });

  it("null payload roundtrips (empty publish shape)", () => {
    const key = testKey(1);
    const wire = sealEnvelope(key, 1, null, {});
    const opened = openEnvelope(extJsonParse(wire) as never, () => key);
    expect(opened.payload).toBeNull();
  });
});

describe("message-key-provider", () => {
  it("derivation is deterministic and generation-sensitive", () => {
    const k1a = deriveMessageKey("A", "B", 1);
    const k1b = deriveMessageKey("A", "B", 1);
    const k2 = deriveMessageKey("A", "B", 2);
    expect(k1a.equals(k1b)).toBe(true);
    expect(k1a.equals(k2)).toBe(false);
    expect(k1a.length).toBe(32); // raw AES-256 key bytes
  });

  it("derivation is partA-sensitive — the split actually splits", () => {
    const leaked = deriveMessageKey("WRONG-PART-A", "B", 1);
    const real = deriveMessageKey(MESSAGE_KEY_PART_A, "B", 1);
    expect(leaked.equals(real)).toBe(false);
  });

  it("provider caches the generation window and exposes current only when complete", async () => {
    const partB = (g: number) => createHmac("sha256", "engine").update(`gen-${g}`).digest("base64url");
    const provider = new MessageKeyProvider(async () => ({
      generation: 3,
      generations: { "1": partB(1), "2": partB(2), "3": partB(3) },
    }));
    expect(provider.ready()).toBe(false);
    expect(provider.currentKey()).toBeNull();
    await provider.refresh();
    expect(provider.ready()).toBe(true);
    expect(provider.currentKey()!.generation).toBe(3);
    // consumers can open older generations inside the window
    expect(provider.keyForGeneration(1)).not.toBeNull();
    expect(provider.keyForGeneration(2)).not.toBeNull();
    // but not generations outside the window
    expect(provider.keyForGeneration(99)).toBeNull();
  });

  it("provider stays unready when the material row is missing (boot before first rotation)", async () => {
    const provider = new MessageKeyProvider(async () => null);
    await provider.refresh();
    expect(provider.ready()).toBe(false);
  });

  it("seal+open through the provider — end-to-end generation flow", async () => {
    const partBv1 = "engine-material-gen7";
    const provider = new MessageKeyProvider(async () => ({
      generation: 7,
      generations: { "7": partBv1 },
    }));
    await provider.refresh();
    const { key, generation } = provider.currentKey()!;
    const wire = sealEnvelope(key, generation, { msg: "hello" }, { "x-user-id": "u" });
    const opened = openEnvelope(extJsonParse(wire) as never, (g) => provider.keyForGeneration(g));
    expect(opened.payload).toEqual({ msg: "hello" });
  });

  it("posterity guard — parte_A constant exists and is non-trivial (regression)", () => {
    // If this test fails someone removed the compile-time half of the split key
    // without the module-certification mechanism in place — read the posterity
    // note in message-key-provider.ts before touching it.
    expect(typeof MESSAGE_KEY_PART_A).toBe("string");
    expect(MESSAGE_KEY_PART_A.length).toBeGreaterThan(32);
  });
});
