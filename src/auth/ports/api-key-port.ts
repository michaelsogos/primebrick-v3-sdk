/**
 * Port for looking up API keys by hash.
 *
 * Used by verifyApiKey() to verify machine-to-machine credentials.
 * The `api_keys` table lives in the public schema — both BE and microservices
 * can implement this (microservices read cross-schema from `public.api_keys`).
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
