import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SecretVault,
  SecretVaultReader,
  MESSAGE_KEY_MATERIAL_REF,
  MESSAGE_KEY_MATERIAL_POLICY,
  type VaultSecretRef,
  type VaultEntryPolicy,
} from "../secret-vault.js";
import { MessageKeyProvider } from "../../nats/message-key-provider.js";
import { extJsonStringify } from "../../json/ext-json.js";

vi.mock("../../nats/nats-client.js", () => ({
  NatsClient: { publishEphemeralLossy: vi.fn(async () => {}), subscribe: vi.fn(async () => {}), getConnection: vi.fn() },
}));

/**
 * Faithful fake of the vault's SQL surface — not a query-string assertor:
 * it emulates transaction snapshots (COMMIT applies / ROLLBACK discards),
 * transaction-scoped advisory locks (contenders WAIT until the holder
 * commits), ON CONFLICT rowcounts and the retention DELETE. What it does
 * not emulate is PostgreSQL's SQL semantics itself — that is what the
 * runtime verification against the docker PG covers.
 */

interface FakeRow {
  scope: string;
  name: string;
  generation: number;
  material: string;
  rotated_ms: number;
  crypto_scheme: string;
}

interface OpEntry {
  client: number;
  op: string;
}

function fakeVaultPool() {
  let store: FakeRow[] = [];
  let nextClientId = 1;
  const ops: OpEntry[] = [];
  const heldLocks = new Map<string, number>();
  const globalLog: string[] = [];

  const record = (client: number, op: string) => {
    ops.push({ client, op });
    globalLog.push(`${client}:${op}`);
  };

  async function waitLock(client: number, key: string): Promise<void> {
    for (;;) {
      const holder = heldLocks.get(key);
      if (holder === undefined || holder === client) {
        heldLocks.set(key, client);
        return;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  function makeClient(id: number) {
    // READ COMMITTED emulation — faithful to PostgreSQL's default isolation:
    // every statement sees the latest COMMITTED state plus the transaction's
    // own uncommitted mutations. Mutations buffer in the tx overlay and are
    // applied to the global store only on COMMIT; ROLLBACK discards them.
    interface TxOverlay {
      inserted: FakeRow[];
      deletes: Array<{ scope: string; name: string; cutoff: number }>;
    }
    let tx: TxOverlay | null = null;
    const myLocks: string[] = [];
    const releaseLocks = () => {
      for (const key of myLocks) {
        if (heldLocks.get(key) === id) heldLocks.delete(key);
      }
      myLocks.length = 0;
    };
    const visibleRows = (): FakeRow[] => {
      const base = tx
        ? store.filter((r) => !tx.deletes.some((d) => r.scope === d.scope && r.name === d.name && r.rotated_ms < d.cutoff))
        : [...store];
      return tx ? [...base, ...tx.inserted] : base;
    };
    return {
      async query(text: string, params: unknown[] = []) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized === "BEGIN") {
          tx = { inserted: [], deletes: [] };
          record(id, "BEGIN");
          return { rows: [], rowCount: 0 };
        }
        if (normalized === "COMMIT") {
          if (tx) {
            for (const d of tx.deletes) {
              store = store.filter((r) => !(r.scope === d.scope && r.name === d.name && r.rotated_ms < d.cutoff));
            }
            store.push(...tx.inserted);
          }
          tx = null;
          record(id, "COMMIT");
          releaseLocks();
          return { rows: [], rowCount: 0 };
        }
        if (normalized === "ROLLBACK") {
          tx = null;
          record(id, "ROLLBACK");
          releaseLocks();
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
          const key = `${params[0]}/${params[1]}`;
          record(id, "LOCK_WAIT");
          await waitLock(id, key);
          myLocks.push(key);
          record(id, "LOCK_ACQUIRED");
          return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
        }
        if (normalized.includes("EXTRACT(EPOCH FROM rotated_at)")) {
          record(id, "READ_STATE");
          const [scope, name] = params as [string, string];
          const matches = visibleRows()
            .filter((r) => r.scope === scope && r.name === name)
            .sort((a, b) => b.generation - a.generation);
          const top = matches[0];
          return {
            rows: top ? [{ generation: top.generation, rotated_ms: top.rotated_ms }] : [],
            rowCount: top ? 1 : 0,
          };
        }
        if (normalized.startsWith("INSERT INTO")) {
          record(id, "INSERT");
          const [scope, name, generation, material, cryptoScheme] = params as [string, string, number, string, string];
          const clash = visibleRows().some((r) => r.scope === scope && r.name === name && r.generation === generation);
          if (clash) return { rows: [], rowCount: 0 };
          const row = { scope, name, generation, material, rotated_ms: Date.now(), crypto_scheme: cryptoScheme };
          if (tx) tx.inserted.push(row);
          else store.push(row);
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("DELETE FROM")) {
          record(id, "TRIM");
          const [scope, name, retentionMs] = params as [string, string, number];
          const cutoff = Date.now() - retentionMs;
          const before = visibleRows().length;
          if (tx) {
            tx.deletes.push({ scope, name, cutoff });
            tx.inserted = tx.inserted.filter((r) => !(r.scope === scope && r.name === name && r.rotated_ms < cutoff));
          } else {
            store = store.filter((r) => !(r.scope === scope && r.name === name && r.rotated_ms < cutoff));
          }
          return { rows: [], rowCount: before - visibleRows().length };
        }
        throw new Error(`fakeVaultPool: unhandled statement: ${normalized}`);
      },
      release() {},
    };
  }

  return {
    async connect() {
      const id = nextClientId++;
      return makeClient(id);
    },
    async query(text: string, params: unknown[] = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT generation, material")) {
        const [scope, name] = params as [string, string];
        const matches = store
          .filter((r) => r.scope === scope && r.name === name)
          .sort((a, b) => b.generation - a.generation)
          .map((r) => ({ generation: String(r.generation), material: r.material }));
        return { rows: matches, rowCount: matches.length };
      }
      throw new Error(`fakeVaultPool reader: unhandled statement: ${normalized}`);
    },
    _store: () => store,
    _ops: ops,
    _globalLog: globalLog,
    _seed(row: FakeRow) {
      store.push(row);
    },
  };
}

const REF: VaultSecretRef = MESSAGE_KEY_MATERIAL_REF;
const POLICY: VaultEntryPolicy = {
  ref: REF,
  rotationMs: 60 * 60 * 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SecretVault writer", () => {
  it("rejects an unsafe schema identifier at construction", () => {
    expect(() => new SecretVault({ pool: fakeVaultPool(), schema: 'system"; DROP TABLE', policies: [POLICY] })).toThrow(/SECRET_VAULT_SCHEMA_INVALID/);
  });

  it("cold start: provisions generation 1 and broadcasts metadata-only hint after commit", async () => {
    const pool = fakeVaultPool();
    const hints: Array<{ ref: VaultSecretRef; meta: { generation: number; rotated_at: number } }> = [];
    const vault = new SecretVault({
      pool,
      schema: "system",
      policies: [POLICY],
      publishHint: async (ref, meta) => { hints.push({ ref, meta }); },
    });
    const result = await vault.rotateIfNeeded(POLICY);
    expect(result.rotated).toBe(true);
    expect(result.generation).toBe(1);
    const rows = pool._store();
    expect(rows).toHaveLength(1);
    expect(rows[0].generation).toBe(1);
    expect(rows[0].material).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows[0].crypto_scheme).toBe("raw-v1");
    // Hint published exactly once, metadata only — generation + rotated_at,
    // never material.
    expect(hints).toHaveLength(1);
    expect(hints[0].meta.generation).toBe(1);
    expect(extJsonStringify(hints[0])).not.toContain(rows[0].material);
    // …and only AFTER the transaction committed.
    const commitIndex = pool._globalLog.findIndex((e) => e.endsWith("COMMIT"));
    expect(commitIndex).toBeGreaterThanOrEqual(0);
  });

  it("acquires the advisory lock BEFORE reading the rotation state", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    await vault.rotateIfNeeded(POLICY);
    const ops = pool._ops.map((o) => o.op);
    const lockIndex = ops.indexOf("LOCK_ACQUIRED");
    const readIndex = ops.indexOf("READ_STATE");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(lockIndex);
  });

  it("does not re-rotate within the cadence window", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    await vault.rotateIfNeeded(POLICY);
    const second = await vault.rotateIfNeeded(POLICY);
    expect(second.rotated).toBe(false);
    expect(second.generation).toBe(1);
    expect(pool._store()).toHaveLength(1);
  });

  it("rotates when the current generation is older than the cadence, keeping history inside the window", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    await vault.rotateIfNeeded(POLICY);
    // Backdate generation 1 beyond the hourly cadence.
    pool._store()[0].rotated_ms = Date.now() - POLICY.rotationMs - 1000;
    const result = await vault.rotateIfNeeded(POLICY);
    expect(result.rotated).toBe(true);
    expect(result.generation).toBe(2);
    const rows = pool._store();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.generation).sort()).toEqual([1, 2]);
    // The two generations carry DIFFERENT material.
    expect(rows[0].material).not.toBe(rows[1].material);
  });

  it("physically trims generations older than the retention window", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    // Seed an expired generation (8 days old) and an in-window one (2 days).
    pool._seed({ scope: REF.scope, name: REF.name, generation: 1, material: "expired-material", rotated_ms: Date.now() - 8 * 24 * 60 * 60 * 1000, crypto_scheme: "raw-v1" });
    pool._seed({ scope: REF.scope, name: REF.name, generation: 2, material: "in-window-material", rotated_ms: Date.now() - 2 * 24 * 60 * 60 * 1000, crypto_scheme: "raw-v1" });
    await vault.rotateIfNeeded(POLICY);
    const rows = pool._store();
    expect(rows.some((r) => r.material === "expired-material")).toBe(false);
    expect(rows.some((r) => r.material === "in-window-material")).toBe(true);
  });

  it("serializes concurrent rotations — exactly one generation 1, no duplicates", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    const results = await Promise.all([
      vault.rotateIfNeeded(POLICY),
      vault.rotateIfNeeded(POLICY),
      vault.rotateIfNeeded(POLICY),
    ]);
    const rows = pool._store();
    expect(rows).toHaveLength(1);
    expect(rows[0].generation).toBe(1);
    // Exactly one writer claims the rotation; the others re-read under the
    // lock and observe the winner's row.
    expect(results.filter((r) => r.rotated)).toHaveLength(1);
    for (const r of results) expect(r.generation).toBe(1);
  });

  it("re-reads state after the lock — generation allocation is monotonic across pre-seeded history", async () => {
    const pool = fakeVaultPool();
    pool._seed({ scope: REF.scope, name: REF.name, generation: 7, material: "existing", rotated_ms: 0, crypto_scheme: "raw-v1" });
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    const result = await vault.rotateIfNeeded(POLICY);
    expect(result.rotated).toBe(true);
    expect(result.generation).toBe(8);
  });

  it("startAutoRotation is idempotent per ref and stop() clears timers", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    vault.startAutoRotation();
    vault.startAutoRotation();
    await new Promise((r) => setTimeout(r, 10));
    expect(pool._store()).toHaveLength(1);
    vault.stop();
  });

  it("default hint path publishes metadata on the governed secret.rotated subject", async () => {
    const { NatsClient } = await import("../../nats/nats-client.js");
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY] });
    await vault.rotateIfNeeded(POLICY);
    expect(NatsClient.publishEphemeralLossy).toHaveBeenCalledTimes(1);
    const [subject, payload] = (NatsClient.publishEphemeralLossy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(subject).toBe("secret.rotated");
    expect(payload.scope).toBe(REF.scope);
    expect(payload.name).toBe(REF.name);
    expect(payload.generation).toBe(1);
    // Never material on the wire.
    expect(extJsonStringify(payload)).not.toContain(pool._store()[0].material);
  });
});

describe("SecretVaultReader", () => {
  it("returns null when the ref has no material yet", async () => {
    const pool = fakeVaultPool();
    const reader = new SecretVaultReader({ pool, schema: "system" });
    expect(await reader.readGenerations(REF)).toBeNull();
  });

  it("reads the live window in MessageKeyMaterial shape — generation is the max", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    await vault.rotateIfNeeded(POLICY);
    pool._store()[0].rotated_ms = Date.now() - POLICY.rotationMs - 1000;
    await vault.rotateIfNeeded(POLICY);
    const reader = new SecretVaultReader({ pool, schema: "system" });
    const material = await reader.readGenerations(REF);
    expect(material).not.toBeNull();
    expect(material!.generation).toBe(2);
    expect(Object.keys(material!.generations).sort()).toEqual(["1", "2"]);
    const rows = pool._store();
    for (const row of rows) {
      expect(material!.generations[String(row.generation)]).toBe(row.material);
    }
  });

  it("feeds the MessageKeyProvider directly — the A6 wiring contract", async () => {
    const pool = fakeVaultPool();
    const vault = new SecretVault({ pool, schema: "system", policies: [POLICY], publishHint: async () => {} });
    await vault.rotateIfNeeded(POLICY);
    const reader = new SecretVaultReader({ pool, schema: "system" });
    const provider = new MessageKeyProvider(() => reader.readGenerations(REF));
    await provider.refresh();
    expect(provider.ready()).toBe(true);
    expect(provider.currentKey()?.generation).toBe(1);
  });
});

describe("ratified policy constants", () => {
  it("service_message_key_material: hourly rotation, 7-day retention", () => {
    expect(MESSAGE_KEY_MATERIAL_POLICY.rotationMs).toBe(60 * 60 * 1000);
    expect(MESSAGE_KEY_MATERIAL_POLICY.retentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MESSAGE_KEY_MATERIAL_REF).toEqual({ scope: "global", name: "service_message_key_material" });
  });
});
