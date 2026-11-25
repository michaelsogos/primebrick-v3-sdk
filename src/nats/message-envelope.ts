/**
 * Message envelope — AEAD encryption for NATS payloads (WP-A, arch/nats-durability).
 *
 * Every durable/ephemeral message crossing the fabric is sealed inside an
 * encrypted envelope: the business payload AND the sensitive user-auth headers
 * travel in ciphertext; only non-confidential transport metadata (otel trace,
 * job correlation ids, shield stamps) stays in cleartext NATS headers.
 *
 * Wire format (ext-json):
 *   { enc: 1, gen: N, iv: b64url(12B), data: b64url(ciphertext || 16B GCM tag) }
 * where plaintext = extJsonStringify({ p: payload, h: sensitiveHeaders }).
 *
 * Properties:
 * - AES-256-GCM: confidentiality AND integrity — a ciphertext that decrypts was
 *   necessarily produced by a key holder (no separate freshness/forgery header).
 * - Decryption failure NEVER delivers to handlers: tampered or foreign messages
 *   are rejected at the plumbing layer.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";

export const ENVELOPE_MARKER = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface MessageEnvelope {
  enc: typeof ENVELOPE_MARKER;
  gen: number;
  iv: string;
  data: string;
}

export interface OpenedEnvelope {
  payload: unknown;
  headers: Record<string, string>;
}

/** Type guard — a parsed wire object is an encrypted envelope. */
export function isEnvelope(parsed: unknown): parsed is MessageEnvelope {
  if (typeof parsed !== "object" || parsed === null) return false;
  const o = parsed as Record<string, unknown>;
  // ext-json wire contract: ALL integer-valued numbers parse back to bigint —
  // enc/gen arrive as bigint, so compare through Number().
  const genOk = typeof o.gen === "number" || typeof o.gen === "bigint";
  return Number(o.enc) === ENVELOPE_MARKER && genOk && typeof o.iv === "string" && typeof o.data === "string";
}

/**
 * Seal payload + sensitive headers into the wire envelope string.
 * `key` is the 32-byte generation key from the MessageKeyProvider.
 */
export function sealEnvelope(
  key: Buffer,
  generation: number,
  payload: unknown,
  headers: Record<string, string>,
): string {
  const iv = randomBytes(IV_BYTES);
  const plaintext = extJsonStringify({ p: payload ?? null, h: headers });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return extJsonStringify({
    enc: ENVELOPE_MARKER,
    gen: generation,
    iv: iv.toString("base64url"),
    data: sealed.toString("base64url"),
  } satisfies MessageEnvelope);
}

export class MessageKeyUnknownError extends Error {
  constructor(generation: number) {
    super(`MESSAGE_KEY_GENERATION_UNKNOWN: no key available for generation ${generation}`);
    this.name = "MessageKeyUnknownError";
  }
}

export class MessageIntegrityViolationError extends Error {
  constructor() {
    super("MESSAGE_INTEGRITY_VIOLATION: ciphertext failed GCM authentication — tampered or foreign");
    this.name = "MessageIntegrityViolationError";
  }
}

/**
 * Open a wire envelope. `keyResolver` maps a generation to its 32-byte key
 * (or null when the generation is outside the retained key window).
 * Throws MessageKeyUnknownError / MessageIntegrityViolationError — callers
 * must never fall back to delivering undecryptable content.
 */
export function openEnvelope(
  envelope: MessageEnvelope,
  keyResolver: (generation: number) => Buffer | null,
): OpenedEnvelope {
  const generation = Number(envelope.gen); // bigint on the wire — generations are small counters
  const key = keyResolver(generation);
  if (!key) throw new MessageKeyUnknownError(generation);
  const sealed = Buffer.from(envelope.data, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new MessageIntegrityViolationError();
  }
  const frame = extJsonParse(plaintext) as { p: unknown; h: Record<string, string> };
  return { payload: frame.p, headers: frame.h ?? {} };
}
