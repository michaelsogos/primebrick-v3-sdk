/**
 * SecretVault — the architectural component for rotating internal secrets
 * (WP-A5, arch/nats-durability). First ref: `service_message_key_material`,
 * the rotating parte_B of the fabric message-encryption split key.
 *
 * Why a component and not a config_entries row: config_entries is an
 * audited entity — every write copies the value into the audit trail, so
 * trimming the live row would never erase historical key material and
 * forward secrecy would be cosmetic. This table is deliberately NOT a
 * governed entity: no CRUD endpoints, no OpenAPI/MCP exposure, no entity
 * audit of the material, ever.
 *
 * Model:
 *
 *   PG      <schema>.secret_vault_generations — ONE ROW PER GENERATION:
 *           (scope, name, generation, material, rotated_at, crypto_scheme)
 *           PK (scope, name, generation). The current generation is simply
 *           max(generation) — no duplicated pointer that can diverge.
 *           Rows older than the retention window are physically deleted;
 *           the rows present ARE the key window — readers need no policy.
 *
 *   Writer  SecretVault — instantiated by the owning service (the BE
 *           today; any module tomorrow — the capability lives in the SDK,
 *           writer ownership is a deploy decision). Rotation is serialized
 *           by a PostgreSQL transaction-scoped advisory lock: re-read after
 *           lock acquisition, SQL-only critical section, broadcast after
 *           commit. Boot self-heals missing material; hourly cadence
 *           rotates; every rotation trims the window in the same tx.
 *
 *   Reader  SecretVaultReader — direct-DAL read-only access for services
 *           (A6 wiring). The output shape matches MessageKeyMaterial, so
 *           feeding the MessageKeyProvider is a one-liner. Key material
 *           NEVER transits on NATS: the only message ever published is the
 *           `secret.rotated` metadata hint (scope/name/generation/rotated_at
 *           — no material), and only AFTER the commit.
 *
 * crypto_scheme is 'raw-v1' today: encryption-at-rest is NOT simulated.
 * A vault key stored in PG would be security theater; one stored in the
 * SDK artifact adds nothing beyond the existing split-key dual control.
 * When external key custody lands (KMS/attestation endgame), the column
 * carries the envelope format without a contract change.
 */

import { randomBytes } from "node:crypto";
import { NatsClient } from "../nats/nats-client.js";
import { logger } from "../lifecycle/logger.js";
import { SECRET_SUBJECTS } from "./rotating-secret.js";

// ─── Structural SQL port — satisfied by pg.Pool without a hard pg dep ───────

export interface SqlQueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}

export interface SqlClientPort {
  query(text: string, params?: unknown[]): Promise<SqlQueryResult>;
  release(): void;
}

export interface SqlPoolPort {
  query(text: string, params?: unknown[]): Promise<SqlQueryResult>;
  connect(): Promise<SqlClientPort>;
}

// ─── Contract ───────────────────────────────────────────────────────────────

export interface VaultSecretRef {
  /** "global" for fleet-wide secrets, or a service/module scope. */
  scope: string;
  name: string;
}

export interface VaultEntryPolicy {
  ref: VaultSecretRef;
  /** Rotation cadence — rotation happens when the current generation is
   *  older than this (checked at boot and on the interval). */
  rotationMs: number;
  /** Retention window — generations older than this are physically deleted
   *  inside every rotation transaction. */
  retentionMs: number;
}

/** The fabric message-key material — rotating parte_B of the split key. */
export const MESSAGE_KEY_MATERIAL_REF: VaultSecretRef = {
  scope: "global",
  name: "service_message_key_material",
};

/** Ratified policy: hourly rotation, 7-day key window (the retention cap). */
export const MESSAGE_KEY_MATERIAL_POLICY: VaultEntryPolicy = {
  ref: MESSAGE_KEY_MATERIAL_REF,
  rotationMs: 60 * 60 * 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Reader output — shaped exactly like MessageKeyMaterial so the A6 wiring
 * is `new MessageKeyProvider(() => reader.readGenerations(ref))`.
 */
export interface VaultGenerations {
  generation: number;
  generations: Record<string, string>;
}

const TABLE = "secret_vault_generations";
const CRYPTO_SCHEME_RAW = "raw-v1";

/**
 * Advisory lock identity — two-int form (namespace, resource). The namespace
 * is a fixed platform constant documented here; the resource is a stable
 * FNV-1a hash of `<scope>/<name>` so different refs never serialize against
 * each other. Collisions are benign (false sharing, never incorrectness).
 * Advisory locks are cooperative: they work because this component is the
 * ONLY sanctioned writer of the table.
 */
const LOCK_NAMESPACE = 920001;

function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

const lockKeyOf = (ref: VaultSecretRef) => fnv1a32(`${ref.scope}/${ref.name}`);

function assertValidSchema(schema: string): void {
  // Schema names cannot be query parameters in SQL — they are interpolated,
  // so the identifier is validated by construction at component setup.
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`SECRET_VAULT_SCHEMA_INVALID: "${schema}" is not a safe SQL identifier`);
  }
}

const newMaterial = () => randomBytes(32).toString("base64url");

// ─── Writer engine ──────────────────────────────────────────────────────────

export class SecretVault {
  private readonly rotationTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly qualifiedTable: string;

  constructor(
    private readonly deps: {
      pool: SqlPoolPort;
      /** Schema owning the vault table (e.g. "system" for the BE fleet vault). */
      schema: string;
      /** Rotation/retention policies this writer owns — closed registry in code,
       *  never user-facing configuration. */
      policies: readonly VaultEntryPolicy[];
      /** Hint publisher — injectable for tests; defaults to the governed
       *  ephemeral broadcast. Metadata only, never material. */
      publishHint?: (ref: VaultSecretRef, meta: { generation: number; rotated_at: number }) => Promise<void>;
    },
  ) {
    assertValidSchema(deps.schema);
    this.qualifiedTable = `${deps.schema}.${TABLE}`;
  }

  private async publishHint(ref: VaultSecretRef, meta: { generation: number; rotated_at: number }): Promise<void> {
    if (this.deps.publishHint) {
      await this.deps.publishHint(ref, meta);
      return;
    }
    await NatsClient.publishEphemeralLossy(SECRET_SUBJECTS.ROTATED, {
      scope: ref.scope,
      name: ref.name,
      generation: meta.generation,
      rotated_at: meta.rotated_at,
    });
  }

  /**
   * Rotate-if-needed: allocate the next generation when the ref has no
   * material yet (boot self-healing) or the current generation is older
   * than the policy cadence. Trimming of expired generations happens in
   * the SAME transaction either way.
   *
   * Critical-section discipline (ratified):
   *   BEGIN → pg_advisory_xact_lock → RE-READ state → maybe INSERT →
   *   DELETE expired → COMMIT → hint broadcast AFTER commit.
   * The lock is transaction-scoped: released automatically on
   * commit/rollback/crash — no TTL, no orphan locks, no second infra.
   */
  async rotateIfNeeded(policy: VaultEntryPolicy): Promise<{ rotated: boolean; generation: number | null }> {
    const { pool } = this.deps;
    const client = await pool.connect();
    let rotated = false;
    let generation: number | null = null;
    let rotatedAtMs: number | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NAMESPACE, lockKeyOf(policy.ref)]);
      // Re-read AFTER lock acquisition — never before: the whole point of
      // the lock is that this read observes any concurrent winner's write.
      const current = await client.query(
        `SELECT generation, EXTRACT(EPOCH FROM rotated_at) * 1000 AS rotated_ms
         FROM ${this.qualifiedTable}
         WHERE scope = $1 AND name = $2
         ORDER BY generation DESC LIMIT 1`,
        [policy.ref.scope, policy.ref.name],
      );
      const row = current.rows[0];
      const currentGeneration = row ? Number(row.generation) : null;
      const currentRotatedMs = row ? Number(row.rotated_ms) : null;
      const due = currentGeneration === null || currentRotatedMs === null || Date.now() - currentRotatedMs >= policy.rotationMs;
      if (due) {
        const nextGeneration = (currentGeneration ?? 0) + 1;
        // ON CONFLICT DO NOTHING + rowcount — defense in depth even against
        // a writer bypassing the advisory lock: a lost race is detected,
        // never silently overwritten.
        const inserted = await client.query(
          `INSERT INTO ${this.qualifiedTable} (scope, name, generation, material, rotated_at, crypto_scheme)
           VALUES ($1, $2, $3, $4, now(), $5)
           ON CONFLICT (scope, name, generation) DO NOTHING`,
          [policy.ref.scope, policy.ref.name, nextGeneration, newMaterial(), CRYPTO_SCHEME_RAW],
        );
        if ((inserted.rowCount ?? 0) > 0) {
          rotated = true;
          generation = nextGeneration;
        } else {
          generation = currentGeneration;
        }
      } else {
        generation = currentGeneration;
      }
      // Trimming runs on every pass — rotation or not — so the window stays
      // physical even if a rotation cadence is skipped by downtime.
      await client.query(
        `DELETE FROM ${this.qualifiedTable}
         WHERE scope = $1 AND name = $2 AND rotated_at < now() - ($3 * interval '1 millisecond')`,
        [policy.ref.scope, policy.ref.name, policy.retentionMs],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (rotated && generation !== null) {
      rotatedAtMs = Date.now();
      // AFTER commit, never inside the transaction: no network I/O inside
      // the lock's critical section.
      await this.publishHint(policy.ref, { generation, rotated_at: rotatedAtMs }).catch((error) => {
        logger.warn("secret vault rotation hint publish failed — consumers refresh on next cadence or boot", {
          tags: ["secret-vault"],
          scope: policy.ref.scope,
          name: policy.ref.name,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info("secret vault rotation committed", {
        tags: ["secret-vault"],
        scope: policy.ref.scope,
        name: policy.ref.name,
        generation,
      });
    }
    return { rotated, generation };
  }

  /** Boot provisioning — ensure every owned ref has live material. */
  async ensureAll(): Promise<void> {
    for (const policy of this.deps.policies) {
      await this.rotateIfNeeded(policy);
    }
  }

  /** Interval driver — ensure now, then check every policy cadence.
   *  Idempotent per ref: a lifecycle re-run must not stack intervals. */
  startAutoRotation(): void {
    for (const policy of this.deps.policies) {
      const timerKey = `${policy.ref.scope}/${policy.ref.name}`;
      if (this.rotationTimers.has(timerKey)) continue;
      void this.rotateIfNeeded(policy).catch((error) =>
        logger.error("secret vault boot provisioning failed", {
          tags: ["secret-vault"],
          scope: policy.ref.scope,
          name: policy.ref.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const timer = setInterval(() => {
        void this.rotateIfNeeded(policy).catch((error) =>
          logger.error("secret vault scheduled rotation failed — retrying at next cadence", {
            tags: ["secret-vault"],
            scope: policy.ref.scope,
            name: policy.ref.name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }, policy.rotationMs);
      this.rotationTimers.set(timerKey, timer);
    }
  }

  /** Stop all cadence timers (shutdown/tests). */
  stop(): void {
    for (const timer of this.rotationTimers.values()) clearInterval(timer);
    this.rotationTimers.clear();
  }
}

// ─── Reader port ────────────────────────────────────────────────────────────

/**
 * Read-only access to the vault generations of a ref. Services consume this
 * through direct DAL — never over NATS. No policy knowledge required: rows
 * older than the retention window no longer exist, so everything present
 * belongs to the live key window.
 */
export class SecretVaultReader {
  private readonly qualifiedTable: string;
  private readonly deps: { pool: SqlPoolPort; schema: string };

  constructor(deps: { pool: SqlPoolPort; schema: string }) {
    assertValidSchema(deps.schema);
    this.deps = deps;
    this.qualifiedTable = `${deps.schema}.${TABLE}`;
  }

  /** null when the ref has no material yet (pre-boot or after a wipe — the
   *  owning writer self-heals it; consumers stay unavailable and retry). */
  async readGenerations(ref: VaultSecretRef): Promise<VaultGenerations | null> {
    const result = await this.deps.pool.query(
      `SELECT generation, material FROM ${this.qualifiedTable}
       WHERE scope = $1 AND name = $2
       ORDER BY generation DESC`,
      [ref.scope, ref.name],
    );
    if (result.rows.length === 0) return null;
    const generations: Record<string, string> = {};
    for (const row of result.rows) {
      generations[String(Number(row.generation))] = String(row.material);
    }
    return {
      generation: Number(result.rows[0].generation),
      generations,
    };
  }
}
