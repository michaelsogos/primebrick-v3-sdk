/**
 * Internal HTTP provenance — proof-of-possession signing and sensitive-header
 * sealing for every service-to-service HTTP call. Doctrine: never transmit
 * the secret, transmit a proof of possessing it. (The retired shield sent
 * the secret itself in cleartext — one sniffed packet was total compromise.)
 *
 * Key derivation reuses the vault-backed message-key material per generation
 * (rotation, trimming, reactive refresh all inherited), separated by label:
 *
 *   signing_key(service, gen) = HMAC(message_key(gen), "http-sign:"+service+":"+gen)
 *   sealing_key(gen)          = HMAC(message_key(gen), "http-seal:"+gen)
 *
 * Per-service signing keys give provenance granularity — the verifier knows
 * WHO signed, not just THAT the signature is valid. Honest limitation (same
 * model as NATS message keys): no isolation against a compromised legitimate
 * service — anyone reading the vault derives everything. The ratified threat
 * model (rogue process in the VLAN, no legitimate service compromise) is
 * fully covered.
 *
 * Wire format on every internal HTTP request:
 *   x-pb-service / x-pb-keygen / x-pb-timestamp / x-pb-nonce / x-pb-signature
 *   x-pb-sealed — AES-GCM blob carrying the sensitive headers (x-user-*, the
 *   configured auth headers) so identity never travels in cleartext.
 */

import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { getMessageKeyProvider } from "../nats/message-key-provider.js";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";
import { AuthError } from "./verify.js";

export const SIGNING_HEADERS = {
  service: "x-pb-service",
  keygen: "x-pb-keygen",
  timestamp: "x-pb-timestamp",
  nonce: "x-pb-nonce",
  signature: "x-pb-signature",
  sealed: "x-pb-sealed",
} as const;

/** Clock-skew window for timestamp acceptance (±30s). */
export const SIGNATURE_SKEW_MS = 30_000;

const IV_BYTES = 12;

// Derived-key caches — derivations are deterministic, so no invalidation is
// ever needed; memory is bounded by the key window (few hundred entries).
const signingCache = new Map<string, Buffer>();
const sealingCache = new Map<number, Buffer>();

function messageKeyForGeneration(generation: number): Buffer | null {
  const provider = getMessageKeyProvider();
  return provider ? provider.keyForGeneration(generation) : null;
}

function currentMessageKey(): { key: Buffer; generation: number } | null {
  const provider = getMessageKeyProvider();
  return provider ? provider.currentKey() : null;
}

function deriveSigningKey(service: string, generation: number): Buffer | null {
  const cacheKey = `${service}:${generation}`;
  const hit = signingCache.get(cacheKey);
  if (hit) return hit;
  const material = messageKeyForGeneration(generation);
  if (!material) return null;
  const key = createHmac("sha256", material).update(`http-sign:${service}:${generation}`).digest();
  signingCache.set(cacheKey, key);
  return key;
}

function deriveSealingKey(generation: number): Buffer | null {
  const hit = sealingCache.get(generation);
  if (hit) return hit;
  const material = messageKeyForGeneration(generation);
  if (!material) return null;
  const key = createHmac("sha256", material).update(`http-seal:${generation}`).digest();
  sealingCache.set(generation, key);
  return key;
}

function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** Canonical string the signature commits to — order and separators are the contract. */
export function buildCanonical(opts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string | Buffer | undefined;
  sealed: string;
}): string {
  const bodyHash = sha256hex(opts.body ?? "");
  const sealedHash = sha256hex(opts.sealed);
  return [
    opts.method.toUpperCase(),
    opts.path,
    opts.timestamp,
    opts.nonce,
    bodyHash,
    sealedHash,
  ].join("\n");
}

function authError(code: string, message: string): AuthError {
  return new AuthError(code, `${code}: ${message}`);
}

// --- sensitive header sealing ---

/** Seal sensitive headers into the transport blob (current generation). */
export function sealSensitiveHeaders(headers: Record<string, string>): { blob: string; generation: number } | null {
  const current = currentMessageKey();
  if (!current) return null;
  const key = deriveSealingKey(current.generation);
  if (!key) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = extJsonStringify(headers);
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    blob: `${iv.toString("base64url")}.${sealed.toString("base64url")}`,
    generation: current.generation,
  };
}

/** Open a transport blob. Throws on tampering — GCM authentication is the integrity proof. */
export function openSensitiveHeaders(blob: string, generation: number): Record<string, string> {
  const key = deriveSealingKey(generation);
  if (!key) {
    throw authError("AUTH_KEY_GENERATION_UNKNOWN", `no sealing key for generation ${generation}`);
  }
  const dot = blob.indexOf(".");
  if (dot <= 0) throw authError("AUTH_SEALED_MALFORMED", "sealed header blob is malformed");
  const iv = Buffer.from(blob.slice(0, dot), "base64url");
  const sealed = Buffer.from(blob.slice(dot + 1), "base64url");
  const tag = sealed.subarray(sealed.length - 16);
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return extJsonParse<Record<string, string>>(plaintext);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw authError("AUTH_SEALED_INTEGRITY", "sealed headers failed GCM authentication — tampered or foreign");
  }
}

// --- publisher side ---

export interface SignInternalRequestInput {
  /** The calling service's own code — declares WHO signs. */
  service: string;
  method: string;
  /** Path + query as sent on the wire (no scheme/host). */
  path: string;
  /** Raw body bytes exactly as transmitted — undefined for bodyless methods. */
  body?: string | Buffer;
  /** Sensitive headers to seal (x-user-*, configured auth headers). */
  sensitiveHeaders?: Record<string, string>;
  nonce?: string;
  timestamp?: number;
}

/**
 * Sign an outbound internal request. Fail-closed (A7 doctrine): without key
 * material this THROWS — an unsigned internal request must never reach the wire.
 */
export function signInternalRequest(input: SignInternalRequestInput): Record<string, string> {
  const current = currentMessageKey();
  if (!current) {
    throw authError("AUTH_SIGNING_KEY_UNAVAILABLE",
      "refusing to emit an unsigned internal request — vault key material not provisioned (boot ordering broken)",
    );
  }
  const signingKey = deriveSigningKey(input.service, current.generation);
  if (!signingKey) {
    throw authError("AUTH_SIGNING_KEY_UNAVAILABLE", `no signing key derivable for service ${input.service}`);
  }
  const timestamp = String(input.timestamp ?? Date.now());
  const nonce = input.nonce ?? crypto.randomUUID();
  let sealed = "";
  if (input.sensitiveHeaders && Object.keys(input.sensitiveHeaders).length > 0) {
    const s = sealSensitiveHeaders(input.sensitiveHeaders);
    if (!s) throw authError("AUTH_SIGNING_KEY_UNAVAILABLE", "no sealing key available for sensitive headers");
    sealed = s.blob;
  }
  const canonical = buildCanonical({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    body: input.body,
    sealed,
  });
  const signature = hmacHex(signingKey, canonical);
  const headers: Record<string, string> = {
    [SIGNING_HEADERS.service]: input.service,
    [SIGNING_HEADERS.keygen]: String(current.generation),
    [SIGNING_HEADERS.timestamp]: timestamp,
    [SIGNING_HEADERS.nonce]: nonce,
    [SIGNING_HEADERS.signature]: signature,
  };
  if (sealed) headers[SIGNING_HEADERS.sealed] = sealed;
  return headers;
}

// --- verifier side ---

export interface VerifyInternalRequestInput {
  method: string;
  path: string;
  body?: string | Buffer;
  getHeader(name: string): string | undefined;
  /** Anti-replay gate (write methods only — wired in WP-2/WP-4). Receives
   *  (service, nonce), returns true if the nonce was already seen. */
  isNonceReplay?: (service: string, nonce: string) => Promise<boolean> | boolean;
  now?: number;
}

export interface VerifiedProvenance {
  /** The signer's declared and proven service code. */
  service: string;
  /** Sensitive headers opened from the sealed blob (empty when absent). */
  sensitiveHeaders: Record<string, string>;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Verify the provenance proof on an inbound internal request. Ordering is
 * the contract — every failure is a distinct 401 code.
 */
export async function verifyInternalRequest(input: VerifyInternalRequestInput): Promise<VerifiedProvenance> {
  const service = input.getHeader(SIGNING_HEADERS.service);
  const keygen = input.getHeader(SIGNING_HEADERS.keygen);
  const timestamp = input.getHeader(SIGNING_HEADERS.timestamp);
  const nonce = input.getHeader(SIGNING_HEADERS.nonce);
  const signature = input.getHeader(SIGNING_HEADERS.signature);
  if (!service || !keygen || !timestamp || !nonce || !signature) {
    throw authError("AUTH_SIGNATURE_MISSING", "internal provenance headers missing");
  }
  const ts = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_SKEW_MS) {
    throw authError("AUTH_SIGNATURE_STALE", "internal provenance timestamp outside the accepted skew window");
  }
  if (WRITE_METHODS.has(input.method.toUpperCase()) && input.isNonceReplay) {
    if (await input.isNonceReplay(service, nonce)) {
      throw authError("AUTH_REPLAY_DETECTED", "internal provenance nonce already seen — replay rejected");
    }
  }
  const generation = Number(keygen);
  if (!Number.isFinite(generation)) {
    throw authError("AUTH_KEY_GENERATION_UNKNOWN", `malformed key generation header`);
  }
  const signingKey = deriveSigningKey(service, generation);
  if (!signingKey) {
    throw authError("AUTH_KEY_GENERATION_UNKNOWN", `no signing key for generation ${generation}`);
  }
  const sealed = input.getHeader(SIGNING_HEADERS.sealed) ?? "";
  const canonical = buildCanonical({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    body: input.body,
    sealed,
  });
  const expected = Buffer.from(hmacHex(signingKey, canonical), "hex");
  const provided = Buffer.from(signature, "hex");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw authError("AUTH_SIGNATURE_INVALID", "internal provenance signature mismatch — forged or tampered");
  }
  const sensitiveHeaders = sealed ? openSensitiveHeaders(sealed, generation) : {};
  return { service, sensitiveHeaders };
}

/** Test-only hook — clears the derived-key caches. */
export function resetHttpSigningForTest(): void {
  signingCache.clear();
  sealingCache.clear();
}
