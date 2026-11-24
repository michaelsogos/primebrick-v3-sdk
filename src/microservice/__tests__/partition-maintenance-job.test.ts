/**
 * partition-maintenance-job — the shared system-trigger declaration +
 * callable contract mounted by createMicroservice.
 *
 * Under test:
 *   materialize via `declareSystemJobs` (the ONLY public path onto
 *     `jobs.ctl.triggers.materialize`) — code-owned contract declared in
 *     code, schedule seeded then user-governed
 *   a failed materialize is non-fatal — the 30s interval tick and the
 *     `service.gateway_online` broadcast keep retrying until it lands
 *   the callable is bound through `makeNatsRoutes` on the service's own
 *     subject with a payload contract — an undeclared callable is
 *     unscheduleable (JH's trigger target check would refuse it)
 *   the callable handler RETURNS the partition report — the SDK route
 *     middleware publishes it as the run outcome on jobs.result.*
 *   handler throw → failed result via the middleware
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  declareJobs: vi.fn(async (_jobs?: unknown, _opts?: unknown) => [
    { key: "testsvc.partition_maintenance", action: "inserted", uuid: "u-1" },
  ]),
  makeNatsRoutes: vi.fn(async (_routes?: unknown, _deps?: unknown) => []),
  subscribeShielded: vi.fn(async (_subject?: unknown, _handler?: unknown) => {}),
  serviceShieldVerify: vi.fn(async (_msg?: unknown) => undefined),
  setProcessInterval: vi.fn((_key?: unknown, _ms?: unknown, _fn?: unknown) => 0 as never),
  run: vi.fn(async () => ({ dropped: 2 })),
  i18nNs: "testsvc" as string,
  reset() {
    this.declareJobs.mockReset();
    this.declareJobs.mockResolvedValue([
      { key: "testsvc.partition_maintenance", action: "inserted", uuid: "u-1" },
    ]);
    this.makeNatsRoutes.mockClear();
    this.subscribeShielded.mockClear();
    this.setProcessInterval.mockClear();
    this.run.mockReset();
    this.run.mockResolvedValue({ dropped: 2 });
    this.i18nNs = "testsvc";
  },
}));

vi.mock("../../nats/system-jobs.js", () => ({ declareSystemJobs: h.declareJobs }));
vi.mock("../../nats/nats-routes.js", () => ({ makeNatsRoutes: h.makeNatsRoutes }));
vi.mock("../../nats/service-shield.js", () => ({
  subscribeShielded: h.subscribeShielded,
  serviceShieldVerify: h.serviceShieldVerify,
}));
vi.mock("../../lifecycle/process-registry.js", () => ({ setProcessInterval: h.setProcessInterval }));
vi.mock("../../service/service-identity.js", () => ({ currentServiceCode: () => "testsvc" }));

vi.mock("../../lifecycle/logger.js", () => ({
  logger: { done: () => {}, warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}));

import { mountPartitionMaintenanceJob } from "../partition-maintenance-job.js";

type Route = {
  subject: string;
  queue?: string;
  permissions: readonly string[];
  verify?: unknown;
  label_key: string;
  description_key: string;
  handler: (ctx: unknown) => Promise<unknown>;
};
const callableRoute = () => (h.makeNatsRoutes.mock.calls[0]![0] as Route[])[0]!;

beforeEach(() => {
  h.reset();
});

describe("partition-maintenance-job — governed materialize", () => {
  it("declares the system job on the service's own namespace at boot", async () => {
    await mountPartitionMaintenanceJob({ needed: true, run: h.run, i18nNs: () => h.i18nNs });
    await vi.waitFor(() => expect(h.declareJobs).toHaveBeenCalledTimes(1));
    expect(h.declareJobs).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          key: "partition_maintenance",
          schedule_spec: "0 3 * * *",
          target_subject: "testsvc.partition_maintenance",
          run_as: "system",
        }),
      ],
      expect.objectContaining({ timeoutMs: 3000 }),
    );
  });

  it("a failed materialize retries on the 30s interval tick until it lands", async () => {
    h.declareJobs.mockRejectedValueOnce(new Error("job-handler down"));
    await mountPartitionMaintenanceJob({ needed: true, run: h.run, i18nNs: () => h.i18nNs });
    await vi.waitFor(() => expect(h.declareJobs).toHaveBeenCalledTimes(1));

    const tick = h.setProcessInterval.mock.calls[0]![2] as () => Promise<void>;
    expect(h.setProcessInterval.mock.calls[0]![0]).toBe("testsvc-partition-materialize-retry");
    await tick();
    expect(h.declareJobs).toHaveBeenCalledTimes(2);

    // Now materialized — further ticks are no-ops.
    await tick();
    expect(h.declareJobs).toHaveBeenCalledTimes(2);
  });

  it("a failed materialize also retries on the service.gateway_online broadcast", async () => {
    h.declareJobs.mockRejectedValueOnce(new Error("timeout"));
    await mountPartitionMaintenanceJob({ needed: true, run: h.run, i18nNs: () => h.i18nNs });
    await vi.waitFor(() => expect(h.declareJobs).toHaveBeenCalledTimes(1));

    const onGateway = h.subscribeShielded.mock.calls.find(
      (c) => c[0] === "service.gateway_online",
    )![1] as () => Promise<void>;
    await onGateway();
    expect(h.declareJobs).toHaveBeenCalledTimes(2);
  });
});

describe("partition-maintenance-job — callable contract", () => {
  it("binds the callable as a queued route on the service's own subject", async () => {
    await mountPartitionMaintenanceJob({ needed: true, run: h.run, i18nNs: () => h.i18nNs });
    const route = callableRoute();
    expect(route.subject).toBe("testsvc.partition_maintenance");
    expect(route.queue).toBe("testsvc");
    // System-lane: no user context — permissions empty AND the route's
    // own `verify` replaces verifyNatsMessage (the arm freezes no
    // client-shield secret — L1 enrollment is the only gate).
    expect(route.permissions).toEqual([]);
    expect(route.verify).toBe(h.serviceShieldVerify);
    // i18n keys ride the owning schema's translation namespace — for a
    // US that namespace IS the service code.
    expect(route.label_key).toBe("testsvc.callable.partition_maintenance.label");
    expect(route.description_key).toBe("testsvc.callable.partition_maintenance.desc");
  });

  it("BE-shaped services (own schema 'public') label keys under the 'app' namespace", async () => {
    h.i18nNs = "app";
    await mountPartitionMaintenanceJob({ needed: true, run: h.run, i18nNs: () => h.i18nNs });
    const route = callableRoute();
    // The subject stays service-coded — only the i18n namespace follows
    // the public→app rule the migration linter enforces on
    // public.translations seeds.
    expect(route.subject).toBe("testsvc.partition_maintenance");
    expect(route.label_key).toBe("app.callable.partition_maintenance.label");
    expect(route.description_key).toBe("app.callable.partition_maintenance.desc");
  });

  it("handler returns the partition report — the middleware's run outcome", async () => {
    await mountPartitionMaintenanceJob({ needed: true, run: h.run, i18nNs: () => h.i18nNs });
    const out = await callableRoute().handler({});
    expect(out).toEqual({ dropped: 2 });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("handler rethrows — failed result via the middleware", async () => {
    h.run.mockRejectedValue(new Error("pg gone"));
    await mountPartitionMaintenanceJob({ needed: true, run: h.run, i18nNs: () => h.i18nNs });
    await expect(callableRoute().handler({})).rejects.toThrow("pg gone");
  });
});
