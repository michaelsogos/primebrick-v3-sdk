/**
 * Message codec — the ONE inbound/outbound wire codec of the fabric.
 *
 * Owns everything between the consumer/producer objects and the wire bytes:
 *   - outbound: split sensitive auth headers into the encrypted envelope,
 *     seal payload+headers when the MessageKeyProvider is ready, plaintext
 *     transitional fallback with warn-once otherwise;
 *   - inbound: detect/open envelopes, merge inner sensitive headers over the
 *     transport view, plaintext legacy passthrough with warn-once;
 *   - the decrypted Msg view exposed to consumers.
 *
 * nats-client.ts owns connection/transport; nats-routes.ts owns governance
 * routes. Neither re-implements serialization — both consume this module.
 */
import { headers } from "@nats-io/transport-node";
import type { Msg, MsgHdrs } from "@nats-io/transport-node";
import { logger } from "../lifecycle/logger.js";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";
import { isEnvelope, openEnvelope, sealEnvelope } from "./message-envelope.js";
import { getMessageKeyProvider } from "./message-key-provider.js";
import { getLoadedAuthConfig } from "../auth/auth-config-cache.js";

const MESSAGE_KEY_PLAINTEXT_WARNED = Symbol.for("primebrick.sdk.message-key-plaintext-warned");
const MESSAGE_KEY_LEGACY_INBOUND_WARNED = Symbol.for("primebrick.sdk.message-key-legacy-inbound-warned");

export interface InboundMessagePayload<T = unknown> {
  data: T;
  headers?: MsgHdrs;
  encrypted: boolean;
}

function mergeInboundHeaders(outer: MsgHdrs | undefined, inner: Record<string, string>): MsgHdrs | undefined {
  if (Object.keys(inner).length === 0) return outer;
  const merged = headers();
  if (outer) {
    for (const [key, values] of outer) {
      for (const value of values) merged.append(key, value);
    }
  }
  for (const [key, value] of Object.entries(inner)) {
    for (const existing of merged.keys()) {
      if (existing.toLowerCase() === key.toLowerCase()) merged.delete(existing);
    }
    merged.set(key, value);
  }
  return merged;
}

function warnLegacyInboundOnce(): void {
  const processFlags = globalThis as Record<symbol, boolean | undefined>;
  if (processFlags[MESSAGE_KEY_LEGACY_INBOUND_WARNED] === true) return;
  processFlags[MESSAGE_KEY_LEGACY_INBOUND_WARNED] = true;
  logger.warn("MESSAGE_KEY_LEGACY_PLAINTEXT inbound passthrough — accepting an unencrypted transitional payload", { tags: ["nats"] });
}

/**
 * Decode an inbound fabric payload. Encrypted envelopes are opened BEFORE
 * auth/validation/handler code and their sensitive headers are merged over
 * the transport header view. Plaintext remains accepted only as the explicit
 * transitional fallback and is warned once per process. Envelope integrity or
 * key failures throw — undecryptable content must never reach a handler.
 */
export function decodeInboundMessage<T = unknown>(
  payload: Uint8Array,
  transportHeaders?: MsgHdrs,
): InboundMessagePayload<T> {
  const text = new TextDecoder().decode(payload);
  if (text === "") return { data: null as T, headers: transportHeaders, encrypted: false };
  const parsed = extJsonParse(text) as unknown;
  if (!isEnvelope(parsed)) {
    warnLegacyInboundOnce();
    return { data: parsed as T, headers: transportHeaders, encrypted: false };
  }
  const provider = getMessageKeyProvider();
  if (!provider) throw new Error("MESSAGE_KEY_PROVIDER_UNAVAILABLE: encrypted payload cannot be opened");
  const opened = openEnvelope(parsed, (generation) => provider.keyForGeneration(generation));
  return {
    data: opened.payload as T,
    headers: mergeInboundHeaders(transportHeaders, opened.headers),
    encrypted: true,
  };
}

/**
 * Read the key generation of a wire envelope WITHOUT opening it — metadata
 * only, for security-log correlation (a tampered ciphertext still carries
 * the generation it claims). Returns null for plaintext or unparseable
 * payloads. Never throws, never exposes payload content.
 */
export function peekEnvelopeGeneration(payload: Uint8Array): number | null {
  try {
    const text = new TextDecoder().decode(payload);
    if (text === "") return null;
    const parsed = extJsonParse(text) as unknown;
    if (!isEnvelope(parsed)) return null;
    return Number(parsed.gen);
  } catch {
    return null;
  }
}

/**
 * Decrypted Msg view — CLOSED by construction. Everything the consumer can
 * read derives from the ONE canonical decrypted payload:
 *   - `data`     → canonical ext-json bytes of the decrypted payload
 *   - `headers`  → transport headers merged with the sealed sensitive ones
 *   - `json()`   → the materialized decrypted payload itself (already
 *                  ext-json decoded, bigint-safe — the reviver parameter of
 *                  the raw Msg contract is meaningless here and ignored)
 *   - `string()` → the canonical ext-json text of the decrypted payload
 * `respond()`, `subject`, `reply`, `sid` and every other property delegate
 * to the original transport message. The ciphertext is unreachable through
 * this view — no accidental access path exists.
 */
export function messageWithInboundView<T>(msg: Msg, inbound: InboundMessagePayload<T>): Msg {
  const canonicalText = extJsonStringify(inbound.data);
  const canonicalBytes = new TextEncoder().encode(canonicalText);
  return new Proxy(msg, {
    get(target, prop, receiver) {
      if (prop === "data") return canonicalBytes;
      if (prop === "headers") return inbound.headers;
      if (prop === "json") return () => inbound.data;
      if (prop === "string") return () => canonicalText;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function encodeOutboundMessage(
  data: unknown,
  hdrs?: Record<string, string>,
): { payload: Uint8Array; transportHeaders: Record<string, string> } {
  const current = getMessageKeyProvider()?.currentKey() ?? null;
  if (current) {
    const configuredAuthHeaders = new Set<string>();
    const authConfig = getLoadedAuthConfig();
    if (authConfig) {
      for (const configured of Object.values(authConfig.gateway.headers)) {
        if (typeof configured === "string") configuredAuthHeaders.add(configured.toLowerCase());
      }
    }
    const sensitiveHeaders: Record<string, string> = {};
    const transportHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(hdrs ?? {})) {
      if (key.toLowerCase().startsWith("x-user-") || configuredAuthHeaders.has(key.toLowerCase())) {
        sensitiveHeaders[key] = value;
      } else {
        transportHeaders[key] = value;
      }
    }
    const wire = sealEnvelope(current.key, current.generation, data, sensitiveHeaders);
    return { payload: new TextEncoder().encode(wire), transportHeaders };
  }
  const processFlags = globalThis as Record<symbol, boolean | undefined>;
  if (processFlags[MESSAGE_KEY_PLAINTEXT_WARNED] !== true) {
    processFlags[MESSAGE_KEY_PLAINTEXT_WARNED] = true;
    logger.warn("MESSAGE_KEY_UNAVAILABLE plaintext fallback — NATS publish is unencrypted until MessageKeyProvider is wired", { tags: ["nats"] });
  }
  return {
    payload: new TextEncoder().encode(extJsonStringify(data)),
    transportHeaders: { ...(hdrs ?? {}) },
  };
}
