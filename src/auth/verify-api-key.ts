/**
 * API key verification — machine-to-machine auth with RBAC.
 *
 * API keys are first-class auth credentials mapped to permissions. The
 * `api_keys` table stores key_hash (SHA-256), permissions array, is_system
 * flag, is_active flag, and optional expires_at.
 *
 * verifyApiKey() extracts the key from the Authorization header, hashes it,
 * looks up the record via ApiKeyPort, and returns an AuthUser with the
 * key's permissions. If is_system=true, the AuthUser bypasses RBAC and
 * the actor defaults to "system".
 */

import type { HeaderProvider } from "./header-provider.js";
import type { AuthUser } from "./types.js";
import { hashApiKey } from "./api-key-hash.js";
import { AuthError } from "./verify.js";
import type { ApiKeyPort } from "./ports/api-key-port.js";

/**
 * Verify an API key from headers and return an AuthUser.
 *
 * Accepts two header formats:
 *   - `Authorization: ApiKey <key>`
 *   - `Authorization: Bearer <key>` (when the key starts with "pbk_")
 *
 * @param headers - Header provider (HTTP or NATS)
 * @param apiKeyPort - Port for looking up API keys by hash
 */
export async function verifyApiKey(
  headers: HeaderProvider,
  apiKeyPort: ApiKeyPort,
): Promise<AuthUser> {
  const authHeader = headers.getHeader("authorization");
  if (!authHeader) {
    throw new AuthError("AUTH_API_KEY_MISSING", "Missing Authorization header");
  }

  let key = "";
  const lower = authHeader.toLowerCase();
  if (lower.startsWith("apikey ")) {
    key = authHeader.slice(7).trim();
  } else if (lower.startsWith("bearer ") && authHeader.slice(7).trim().startsWith("pbk_")) {
    key = authHeader.slice(7).trim();
  } else {
    throw new AuthError("AUTH_API_KEY_MISSING", "Missing API key in Authorization header");
  }

  if (!key) {
    throw new AuthError("AUTH_API_KEY_MISSING", "Empty API key");
  }

  const hash = hashApiKey(key);
  const record = await apiKeyPort.findByHash(hash);
  if (!record) {
    throw new AuthError("AUTH_API_KEY_INVALID", "Invalid API key");
  }

  if (!record.is_active) {
    throw new AuthError("AUTH_API_KEY_INACTIVE", "API key is inactive");
  }

  if (record.expires_at && record.expires_at.getTime() < Date.now()) {
    throw new AuthError("AUTH_API_KEY_EXPIRED", "API key has expired");
  }

  // Build AuthUser from API key record
  if (record.is_system) {
    return {
      id: "system",
      idp_code: `apikey:${record.uuid}`,
      email: null,
      name: record.name,
      roles: [],
      permissions: new Set(["*"]), // bypasses all RBAC via isSystem
      isAdmin: false,
      isSystem: true,
      idp_org: null,
      idp_username: null,
    };
  }

  return {
    id: `apikey:${record.uuid}`,
    idp_code: `apikey:${record.uuid}`,
    email: null,
    name: record.name,
    roles: [],
    permissions: new Set(record.permissions),
    isAdmin: false,
    isSystem: false,
    idp_org: null,
    idp_username: null,
  };
}
