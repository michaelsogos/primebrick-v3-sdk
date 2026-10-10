/**
 * Rotating gateway-secret slot — the in-memory view of the shared secret
 * that BOTH sides of the wire read synchronously:
 *
 *   - publisher side: serializeAuthUserToHeaders writes `current` into the
 *     gateway secret header on every outbound message;
 *   - subscriber side: verifyGatewaySecret accepts `current` OR `previous`
 *     while `previous` is inside the grace window — so an in-flight call
 *     issued just before a rotation is not rejected mid-flight.
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

export interface GatewaySecretSlot {
  current: string;
  previous: string | null;
  /** Epoch ms of the last rotation. */
  rotated_at: number;
}

let slot: GatewaySecretSlot | null = null;

export function setGatewaySecretSlot(s: GatewaySecretSlot | null): void {
  slot = s;
}

export function getGatewaySecretSlot(): GatewaySecretSlot | null {
  return slot;
}

/** The value a publisher must stamp on outbound calls. */
export function currentGatewaySecret(fallback?: string): string | undefined {
  return slot?.current ?? fallback;
}

/** All values a subscriber may accept right now (current + in-grace previous). */
export function validGatewaySecrets(graceMs: number, fallback?: string): string[] {
  if (!slot) return fallback ? [fallback] : [];
  const out = [slot.current];
  if (slot.previous && Date.now() - slot.rotated_at <= graceMs) out.push(slot.previous);
  return out;
}
