/**
 * ApiKeyPort implementation over NATS request-reply.
 *
 * For services WITHOUT a database (e.g. the `webhook` ingress): the
 * `api_keys` table lives in the public schema owned by BE, so lookup is
 * delegated to the BE `auth.apikey.byHash` req/reply endpoint (which
 * itself is Redis-cached). Callers typically wrap this port in an
 * in-memory TTL cache so repeated verifications don't hit NATS at all.
 */

import { NatsClient } from "../../nats/nats-client.js";
import type { ApiKeyPort, ApiKeyRecord } from "./api-key-port.js";

export class NatsApiKeyPort implements ApiKeyPort {
  /**
   * @param timeoutMs - NATS request timeout. Keep it short: this port
   *   backs authentication prechecks — fail fast, fail closed.
   */
  constructor(private timeoutMs: number = 3000) {}

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const record = await NatsClient.request<
      Omit<ApiKeyRecord, "expires_at"> & { expires_at: string | null }
    >("auth.apikey.byHash", { hash }, this.timeoutMs);
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
