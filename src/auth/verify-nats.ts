/**
 * NATS convenience wrapper for verifyAuthGatewayResolved.
 *
 * Microservices use GATEWAY-RESOLVED mode for NATS: the BE publisher serializes
 * the full AuthUser into NATS headers, the subscriber verifies the gateway secret
 * and deserializes the AuthUser. NO ports needed.
 *
 * Also includes buildNatsAuthHeaders() — the publisher-side helper that wraps
 * serializeAuthUserToHeaders() and adds the gateway secret.
 */

import type { Msg } from "nats";
import type { AuthConfig, AuthUser } from "./types.js";
import { NatsHeaderProvider } from "./header-provider.js";
import { verifyAuthGatewayResolved } from "./verify.js";
import { serializeAuthUserToHeaders } from "./auth-user-serializer.js";

/**
 * Verify auth from a NATS message (microservice subscriber side).
 * GATEWAY-RESOLVED mode — no ports needed.
 */
export async function verifyNatsMessage(
  msg: Msg,
  config: AuthConfig,
): Promise<AuthUser> {
  const headers = new NatsHeaderProvider(msg);
  return verifyAuthGatewayResolved(headers, config);
}

/**
 * Build NATS headers from a resolved AuthUser (publisher side, BE).
 * Wraps serializeAuthUserToHeaders() — includes gateway secret for anti-spoofing.
 */
export function buildNatsAuthHeaders(
  user: AuthUser,
  config: AuthConfig,
): Record<string, string> {
  return serializeAuthUserToHeaders(user, config);
}
