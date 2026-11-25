import { describe, it, expect, vi, afterEach } from "vitest";
import type { Msg } from "@nats-io/transport-node";
import { decodeInboundMessage, messageWithInboundView, peekEnvelopeGeneration } from "../message-codec.js";
import { sealEnvelope } from "../message-envelope.js";
import { MessageKeyProvider, setMessageKeyProvider } from "../message-key-provider.js";
import { extJsonParse, extJsonStringify } from "../../json/ext-json.js";
import { randomBytes } from "node:crypto";

/**
 * Codec-level contract specs — the codec OWNS the wire representation, so
 * this file is the legitimate owner of `.json()` view-method assertions
 * (declared in .devin/check-standards.json allowPaths: the method call here
 * is the contract under test, never a wire read).
 */

function fakeTransportMsg(wireBytes: Uint8Array, respond: () => boolean): Msg {
  return {
    data: wireBytes,
    headers: undefined,
    reply: "reply.subject",
    subject: "test.subject",
    sid: 1,
    respond,
    // The raw transport message's json()/string() are bound to the wire
    // ciphertext — the decrypted view MUST NOT inherit them.
    json: () => ({ ciphertext_leak: true }),
    string: () => new TextDecoder().decode(wireBytes),
  } as unknown as Msg;
}

describe("messageWithInboundView — closed by construction", () => {
  afterEach(() => {
    setMessageKeyProvider(null);
  });

  it("derives data/json/string from the ONE canonical decrypted payload; respond/subject/reply delegate", async () => {
    const partB = randomBytes(32).toString("base64url");
    const provider = new MessageKeyProvider(async () => ({
      generation: 3,
      generations: { "3": partB },
    }), "test-part-a");
    await provider.refresh();
    setMessageKeyProvider(provider);

    const current = provider.currentKey();
    expect(current).not.toBeNull();
    const plaintextPayload = { secret_field: "sealed-value", entity_id: 123n };
    const wire = sealEnvelope(current!.key, current!.generation, plaintextPayload, { "x-user-id": "user-view" });
    const wireBytes = new TextEncoder().encode(wire);
    const respond = vi.fn(() => true);
    const transportMsg = fakeTransportMsg(wireBytes, respond);

    const inbound = decodeInboundMessage<{ secret_field: string; entity_id: bigint }>(wireBytes, undefined);
    expect(inbound.encrypted).toBe(true);
    const view = messageWithInboundView(transportMsg, inbound);

    // json() materializes the decrypted payload — never the ciphertext object
    // the raw transport message would have returned.
    expect(view.json()).toEqual(plaintextPayload);
    expect(view.json()).not.toEqual({ ciphertext_leak: true });
    // string() is the canonical ext-json text of the decrypted payload —
    // never the wire ciphertext text.
    const viewText = view.string();
    expect(viewText).not.toBe(new TextDecoder().decode(wireBytes));
    expect(extJsonParse(viewText)).toEqual(plaintextPayload);
    // data bytes decode back to the same canonical payload.
    expect(new TextDecoder().decode(view.data)).not.toBe(new TextDecoder().decode(wireBytes));
    expect(extJsonParse(new TextDecoder().decode(view.data))).toEqual(plaintextPayload);
    // respond/subject/reply/sid delegate to the original transport message.
    view.respond();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(view.subject).toBe("test.subject");
    expect(view.reply).toBe("reply.subject");
    expect(view.sid).toBe(1);
  });
});

describe("peekEnvelopeGeneration", () => {
  it("reads the generation metadata of an envelope without opening it", () => {
    const key = randomBytes(32);
    const wire = sealEnvelope(key, 42, { hidden: "payload" }, {});
    const bytes = new TextEncoder().encode(wire);
    expect(peekEnvelopeGeneration(bytes)).toBe(42);
  });

  it("returns null for plaintext payloads and empty input", () => {
    expect(peekEnvelopeGeneration(new TextEncoder().encode(extJsonStringify({ plain: true })))).toBeNull();
    expect(peekEnvelopeGeneration(new Uint8Array(0))).toBeNull();
    expect(peekEnvelopeGeneration(new TextEncoder().encode("not json at all {{{"))).toBeNull();
  });
});
