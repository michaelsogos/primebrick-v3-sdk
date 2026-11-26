/**
 * Regression suite for the silent marker crash: the dal passes the DAL_NOW
 * sentinel (a symbol) as changedAt on EVERY write — the pre-fix marker called
 * `.getTime()` on it, threw, and the fire-and-forget catch swallowed the
 * TypeError, so entity-changed markers were NEVER published for
 * UPDATE/DELETE/RESTORE. These specs pin the ratified fallback chain:
 * entity's fresh updated_at first, audit-row changed_at (DB clock) otherwise.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeMarkerAuditPort, type MarkerAuditParams, type MarkerAuditResult } from "./marker-audit-port.js";
import { NatsClient } from "../nats/nats-client.js";

const published: Array<{ subject: string; marker: Record<string, unknown> }> = [];

vi.spyOn(NatsClient, "isConnected").mockReturnValue(true);
vi.spyOn(NatsClient, "publishEphemeralLossy").mockImplementation(async (subject: string, data: unknown) => {
  published.push({ subject, marker: data as Record<string, unknown> });
});

function dalShapedParams(overrides: Partial<MarkerAuditParams> = {}): MarkerAuditParams {
  return {
    entityClassName: "JobTrigger",
    tableName: "job_trigger",
    entityId: null,
    entityUuid: "uuid-1",
    action: "UPDATE",
    // EXACTLY what the dal passes in production — the sentinel, never a Date
    changedAt: Symbol("dal_now"),
    version: 3n,
    changedBy: "system:jobs",
    delta: {},
    ...overrides,
  };
}

function innerPort(result?: Partial<MarkerAuditResult>) {
  const auditChangedAt = new Date("2026-11-25T22:00:00.000Z");
  return {
    writeAudit: vi.fn(async () => ({
      key: "audit-uuid-1",
      changed_at: auditChangedAt,
      ...result,
    })),
    auditChangedAt,
  };
}

beforeEach(() => {
  published.length = 0;
});

describe("makeMarkerAuditPort — DAL_NOW regression", () => {
  it("survives the symbol sentinel and publishes the UPDATE marker", async () => {
    const entityTime = new Date("2026-11-25T22:00:01.000Z");
    const inner = innerPort();
    const port = makeMarkerAuditPort(inner, "job_trigger");

    const result = await port.writeAudit(dalShapedParams({ entity_updated_at: entityTime }));

    expect(result.key).toBe("audit-uuid-1");
    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe("entity.job_trigger.uuid-1.changed");
    // prefers the entity's freshly stamped updated_at — the canonical time
    expect(published[0].marker.changed_at).toBe(entityTime.getTime());
    expect(published[0].marker.audit_log_id).toBe("audit-uuid-1");
  });

  it("falls back to the audit row's DB-clock changed_at when entity_updated_at is absent (HARD_DELETE)", async () => {
    const inner = innerPort();
    const port = makeMarkerAuditPort(inner, "job_trigger");

    await port.writeAudit(dalShapedParams({ action: "HARD_DELETE", entity_updated_at: null }));

    expect(published).toHaveLength(1);
    expect(published[0].marker.changed_at).toBe(inner.auditChangedAt.getTime());
  });

  it("never throws and never marks INSERT (no concurrent viewers)", async () => {
    const inner = innerPort();
    const port = makeMarkerAuditPort(inner, "job_trigger");

    const result = await port.writeAudit(dalShapedParams({ action: "INSERT", entity_updated_at: new Date() }));

    expect(result.key).toBe("audit-uuid-1");
    expect(published).toHaveLength(0);
  });

  it("bigint audit keys convert to number for the wire marker", async () => {
    const inner = innerPort({ key: 42n });
    const port = makeMarkerAuditPort(inner, "job_trigger");

    await port.writeAudit(dalShapedParams({ entity_updated_at: new Date() }));

    expect(published[0].marker.audit_log_id).toBe(42);
  });
});
