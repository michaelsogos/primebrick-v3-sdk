export interface EnvSchema {
  [key: string]: {
    required: boolean;
    default?: string;
    description?: string;
  };
}

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  env: Record<string, string | undefined>;
}

/**
 * Centralized env var validation. Replaces scattered inline checks
 * (emailsender: dal.ts:18-20, http-server.ts:5-9, webhook-service.ts:9-14,
 * email-service.ts:12-17; BE: src/db/pool.ts).
 *
 * Pure process.env — no DB dependency.
 */
export function validateEnv(schema: EnvSchema): EnvValidationResult {
  const errors: string[] = [];
  const env: Record<string, string | undefined> = {};

  for (const [key, spec] of Object.entries(schema)) {
    const value = process.env[key] ?? spec.default;
    env[key] = value;
    if (spec.required && (value === undefined || value === "")) {
      errors.push(`${key} is required${spec.description ? ` (${spec.description})` : ""}`);
    }
  }

  return { valid: errors.length === 0, errors, env };
}

/**
 * Validate env vars and throw if any required ones are missing.
 */
export function requireEnv(schema: EnvSchema): Record<string, string | undefined> {
  const result = validateEnv(schema);
  if (!result.valid) {
    throw new Error(`Environment validation failed:\n  - ${result.errors.join("\n  - ")}`);
  }
  return result.env;
}
