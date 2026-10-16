/**
 * ApiKeyPort implementation over NATS request-reply.
 *
 * For any microservice: the `api_keys` table lives in the BE-owned
 * `public` schema — schema sovereignty forbids reading it directly, so
 * lookup is delegated to the BE `auth.apikey.byHash` req/reply endpoint
 * (which itself is Redis-cached). Callers wrap this port in
 * `CachingApiKeyPort` so repeated verifications don't hit NATS at all.
 */

import { callNats } from "../../nats/nats-routes.js";
import type { ApiKeyPort, ApiKeyRecord } from "./api-key-port.js";

export class NatsApiKeyPort implements ApiKeyPort {
  /**
   * @param timeoutMs - NATS correlation timeout. Keep it short: this port
   *   backs authentication prechecks — fail fast, fail closed.
   */
  constructor(private timeoutMs: number = 3000) {}

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const record = await callNats<
      Omit<ApiKeyRecord, "expires_at"> & { expires_at: string | null }
    >("auth.apikey.byHash", { hash }, { timeoutMs: this.timeoutMs });
    if (!record) return null;
    return {
      uuid: record.uuid,
      name: record.name,
      permissions: record.permissions,
      is_system: record.is_system,
      is_active: record.is_active,
      expires_at: record.expires_at ? new Date(record.expires_at) : null,
    };
  }
}
