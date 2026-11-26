/**
 * NATS service shield — RETIRED (arch-internal-trust-and-transports, WP-5).
 *
 * The client-shield registry verified publisher identity (UA + transmitted
 * key) on governed routes. Post-A7 that check is redundant by construction:
 * every message on a governed route is a sealed envelope, and producing one
 * requires possession of vault-derived fleet keys — the ciphertext IS the
 * proof. An unauthorized process cannot publish anything valid at all, so
 * there is nothing left to gate.
 *
 * What remains here is mechanical compatibility only: thin pass-throughs so
 * existing call sites keep compiling while consumers migrate to plain
 * `NatsClient.subscribe`. New code MUST NOT use these aliases.
 */

import type { Msg, MsgHdrs } from "@nats-io/transport-node";
import { NatsClient } from "./nats-client.js";

/** @deprecated retired with the shield — always passes; the envelope is the proof. */
export interface ShieldRegistryLike {
  readonly allowedPrefixes: readonly string[];
  verifyKey(uaPrefix: string, presentedKey: string): boolean;
  refresh?(): Promise<unknown>;
}

/** @deprecated retired with the shield — no-op. */
export function setNatsShieldRegistry(_r: ShieldRegistryLike | null): void {
  // no-op — the registry no longer exists
}

/** @deprecated retired with the shield — always null. */
export function getNatsShieldRegistry(): ShieldRegistryLike | null {
  return null;
}

/** @deprecated retired with the shield — always true; the envelope is the proof. */
export async function verifyNatsPublisher(_msg: { subject?: string; headers?: MsgHdrs }): Promise<boolean> {
  return true;
}

/** @deprecated retired with the shield — always passes. */
export const serviceShieldVerify = async (_msg: Msg) => undefined;

/** @deprecated plain alias — use NatsClient.subscribe directly in new code. */
export async function subscribeShielded<T = unknown>(
  subject: string,
  handler: (payload: T, msg: Msg) => Promise<unknown>,
  opts?: { queue?: string },
): Promise<void> {
  await NatsClient.subscribe<T>(subject, handler, opts);
}
