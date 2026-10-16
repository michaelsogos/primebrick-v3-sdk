/**
 * Port for looking up API keys by hash.
 *
 * Used by verifyApiKey() to verify machine-to-machine credentials.
 * The `api_keys` table lives in the BE-owned `public` schema — only the BE
 * may read it directly (`DomainApiKeyPort`); microservices resolve through the
 * governed `auth.apikey.byHash` NATS route (`NatsApiKeyPort`). Both are
 * wrapped by `CachingApiKeyPort` for the shared Redis/in-memory cache.
 */

export interface ApiKeyRecord {
  uuid: string;
  name: string;
  permissions: string[];
  is_system: boolean;
  is_active: boolean;
  expires_at: Date | null;
}

export interface ApiKeyPort {
  /** Find an API key by its SHA-256 hash. Returns null if not found. */
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
}
