/**
 * HTTP convenience wrapper for verifyAuth / verifyAuthGatewayResolved.
 *
 * Works with raw Node.js IncomingMessage (microservices using createHttpServer)
 * and Express Request (BE — via a thin adapter).
 *
 * When `ports` is provided → STANDALONE mode (BE).
 * When `ports` is omitted → GATEWAY-RESOLVED mode (microservices).
 */

import type { IncomingMessage } from "node:http";
import type { AuthConfig, AuthUser } from "./types.js";
import { HttpHeaderProvider } from "./header-provider.js";
import { verifyAuth, verifyAuthGatewayResolved, type AuthPorts } from "./verify.js";

/**
 * Verify auth from an HTTP request.
 *
 * @param req - Raw Node.js IncomingMessage (or Express Request which extends it)
 * @param config - Auth configuration
 * @param ports - Auth ports (UserResolverPort + RoleMappingPort). Required for STANDALONE mode (BE). Omit for GATEWAY-RESOLVED mode (microservices).
 */
export async function verifyHttpRequest(
  req: IncomingMessage,
  config: AuthConfig,
  ports?: AuthPorts,
): Promise<AuthUser> {
  const headers = new HttpHeaderProvider(req);
  if (ports) {
    return verifyAuth(headers, config, ports);
  }
  return verifyAuthGatewayResolved(headers, config);
}
