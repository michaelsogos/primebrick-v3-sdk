import { describe, it, expect } from "vitest";
import {
  isAccessGranted,
  isAccessKey,
  accessLeafKey,
  accessSheetKey,
  isAccessGrantLegal,
} from "../access.js";

/**
 * Access-axis evaluator — `access.{app}.{module}.{leaf}`.
 * Same permission pipeline as entity RBAC, different vocabulary and a
 * different matching model: exact string or grant-side `*` regex —
 * NEVER ancestor coverage, NEVER an is_admin short-circuit.
 */
describe("isAccessKey", () => {
  it("accepts access.* keys, rejects everything else", () => {
    expect(isAccessKey("access.system")).toBe(true);
    expect(isAccessKey("access.system.job.rules")).toBe(true);
    expect(isAccessKey("access")).toBe(false); // bare root — needs a level
    expect(isAccessKey("customer.read.all")).toBe(false);
    expect(isAccessKey("access.system.*")).toBe(false); // wildcard not a key
    expect(isAccessKey(42)).toBe(false);
  });
});

describe("isAccessGranted — pure pattern matching", () => {
  const user = (grants: string[]) => new Set(grants);

  it("absent requirement is open", () => {
    expect(isAccessGranted([])).toBe(true);
    expect(isAccessGranted([], "")).toBe(true);
  });

  it("exact grants cover only their own leaf — namespaces cover nothing", () => {
    expect(isAccessGranted(user(["access.system.job.rules"]), "access.system.job.rules")).toBe(true);
    // A bare namespace is not a leaf — it covers nothing but itself.
    expect(isAccessGranted(user(["access.system.job"]), "access.system.job.rules")).toBe(false);
    expect(isAccessGranted(user(["access.system.job"]), "access.system.job")).toBe(true); // still covers its own string — vacuous but consistent
    // Siblings never cover each other.
    expect(isAccessGranted(user(["access.system.job.rules"]), "access.system.job.runs")).toBe(false);
    // A leaf grant does NOT climb.
    expect(isAccessGranted(user(["access.system.job.rules"]), "access.system.job")).toBe(false);
  });

  it("grant-side wildcards work at every level — app, module, subtree", () => {
    expect(isAccessGranted(user(["access.system.*"]), "access.system.job.rules")).toBe(true);
    expect(isAccessGranted(user(["access.system.job.*"]), "access.system.job.rules")).toBe(true);
    expect(isAccessGranted(user(["access.system.job.*"]), "access.system.job.admin.flags")).toBe(true);
    // But a wildcard never covers its own bare parent key.
    expect(isAccessGranted(user(["access.system.job.*"]), "access.system.job")).toBe(false);
    expect(isAccessGranted(user(["access.system.*"]), "access.crm.x")).toBe(false);
    expect(isAccessGranted(user(["access.*"]), "access.crm.anything.here")).toBe(true);
  });

  it("no is_admin short-circuit — admin sees only what its grants cover", () => {
    // Grants are always explicit; there is no implicit access.system.
    expect(isAccessGranted([], "access.system.settings")).toBe(false);
    expect(isAccessGranted(user(["access.system.*"]), "access.system.job.rules")).toBe(true);
    expect(isAccessGranted(user(["access.system.*"]), "access.crm.customers")).toBe(false);
    expect(isAccessGranted(user(["access.crm.*"]), "access.crm.customers")).toBe(true);
  });

  it("non-access requirements fail closed", () => {
    expect(isAccessGranted(user(["customer.read.all"]), "customer.read.all")).toBe(false);
    expect(isAccessGranted([], "not-an-access-key")).toBe(false);
  });
});

describe("accessLeafKey — route path → access key", () => {
  it("derives the leaf key from the path after the module prefix", () => {
    expect(accessLeafKey("access.system.job", "rules")).toBe("access.system.job.rules");
    expect(accessLeafKey("access.system.job", "/job-schedules")).toBe("access.system.job.job-schedules");
    expect(accessLeafKey("access.system.job", "admin/flags")).toBe("access.system.job.admin.flags");
  });

  it("collapses create and [param] subroutes into the owning leaf", () => {
    expect(accessLeafKey("access.system.job", "job-schedules/create")).toBe("access.system.job.job-schedules");
    expect(accessLeafKey("access.system.job", "job-schedules/[uuid]")).toBe("access.system.job.job-schedules");
    expect(accessLeafKey("access.crm", "customers/create")).toBe("access.crm.customers");
  });
});

describe("accessSheetKey — sheet key → access key", () => {
  it("strips the code prefix and attaches the name to the module ns", () => {
    expect(accessSheetKey("access.system.job", "job", "job.runDetail")).toBe("access.system.job.runDetail");
    expect(accessSheetKey("access.system.ai", "ai", "ai.modelCache")).toBe("access.system.ai.modelCache");
  });
});

describe("isAccessGrantLegal — write-path grammar", () => {
  const leaves = new Set(["access.system.job.rules", "access.crm.customers"]);

  it("rejects the axis root and the axis-wide wildcard", () => {
    expect(isAccessGrantLegal("access")).toBe(false);
    expect(isAccessGrantLegal("access.*")).toBe(false);
    expect(isAccessGrantLegal("not-access.system.job")).toBe(false);
  });

  it("accepts wildcards at app/module/subtree level — trailing segment only", () => {
    expect(isAccessGrantLegal("access.system.*")).toBe(true);
    expect(isAccessGrantLegal("access.crm.*")).toBe(true);
    expect(isAccessGrantLegal("access.system.job.*")).toBe(true);
    expect(isAccessGrantLegal("access.system.job.admin.*")).toBe(true);
    // Mid-segment or embedded wildcards are illegal.
    expect(isAccessGrantLegal("access.sys*em.*")).toBe(false);
    expect(isAccessGrantLegal("access.system.j*b.*")).toBe(false);
    expect(isAccessGrantLegal("access.*.job")).toBe(false);
    expect(isAccessGrantLegal("access.system.**")).toBe(false);
  });

  it("exact grants must name a real leaf when the inventory is known", () => {
    expect(isAccessGrantLegal("access.system.job.rules", leaves)).toBe(true);
    expect(isAccessGrantLegal("access.crm.customers", leaves)).toBe(true);
    // A bare namespace is a namespace, not a leaf → illegal.
    expect(isAccessGrantLegal("access.system.job", leaves)).toBe(false);
    expect(isAccessGrantLegal("access.system", leaves)).toBe(false);
    // A typo'd leaf is illegal, not a dead grant.
    expect(isAccessGrantLegal("access.system.job.rulles", leaves)).toBe(false);
  });

  it("without an inventory it checks structure only", () => {
    expect(isAccessGrantLegal("access.system.job.rules")).toBe(true);
    expect(isAccessGrantLegal("access.system.job")).toBe(true); // no inventory → cannot tell leaf from ns
  });
});
