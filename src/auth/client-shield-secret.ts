/**
 * Rotating client-shield secret slot — the in-memory view of the shared
 * `service_client_shield_secret` that BOTH sides of the wire read
 * synchronously:
 *
 *   - publisher side: serializeAuthUserToHeaders writes `current` into the
 *     client-shield secret header on every outbound message;
 *   - subscriber side: verifyClientShieldSecret accepts `current` OR
 *     `previous` while `previous` is inside the grace window — so an
 *     in-flight call issued just before a rotation is not rejected
 *     mid-flight.
 *
 * The slot is populated by the RotatingSecretEngine (BE, the owner) and by
 * SecretProvider (every consumer, incl. BE itself for its outbound calls).
 * When no slot is set (pre-engine code paths, unit tests) callers fall back
 * to the static `config.gateway.secret` from auth config — which is exactly
 * why the rotation is governed rather than breaking.
 *
 * The secret itself NEVER lives in config_entries or on disk: it is
 * generated into Redis with a TTL, provisioned over the governed NATS
 * correlation route `secret.get`, and refreshed on the shielded broadcast
 * `secret.rotated`.
 */

/** Rotation cadence + how long `previous` stays acceptable. */
export const SECRET_DEFAULTS = {
  rotationMs: 60 * 60_000,
  graceMs: 5 * 60_000,
} as const;

/** Canonical ref of the rotating client-shield secret. */
export const CLIENT_SHIELD_SECRET_REF = {
  scope: "global",
  name: "service_client_shield_secret",
} as const;

export interface ClientShieldSecretSlot {
  current: string;
  previous: string | null;
  /** Epoch ms of the last rotation. */
  rotated_at: number;
}

let slot: ClientShieldSecretSlot | null = null;

export function setClientShieldSecretSlot(s: ClientShieldSecretSlot | null): void {
  slot = s;
}

export function getClientShieldSecretSlot(): ClientShieldSecretSlot | null {
  return slot;
}

/** The value a publisher must stamp on outbound calls. */
export function currentClientShieldSecret(fallback?: string): string | undefined {
  return slot?.current ?? fallback;
}

/** All values a subscriber may accept right now (current + in-grace previous). */
export function validClientShieldSecrets(graceMs: number, fallback?: string): string[] {
  if (!slot) return fallback ? [fallback] : [];
  const out = [slot.current];
  if (slot.previous && Date.now() - slot.rotated_at <= graceMs) out.push(slot.previous);
  return out;
}

/** "3600000" → "1 hour", "27000" → "27 seconds", "300000" → "5 minutes". */
export function humanizeMs(ms: number): string {
  if (ms % 3_600_000 === 0) {
    const h = ms / 3_600_000;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (ms % 60_000 === 0) {
    const m = ms / 60_000;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (ms % 1_000 === 0) {
    const s = ms / 1_000;
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  return `${ms} milliseconds`;
}
