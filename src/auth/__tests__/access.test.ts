import { describe, it, expect } from "vitest";
import { isAccessGranted, isAccessKey, ADMIN_INHERITED_ACCESS } from "../access.js";

/**
 * Access-axis evaluator — `access.{app}.{module}.{page}`.
 * Same permission pipeline as entity RBAC, different vocabulary and
 * different admin rule: is_admin implies `access.system` ONLY.
 */
describe("isAccessKey", () => {
  it("accepts access.* keys, rejects everything else", () => {
    expect(isAccessKey("access.system")).toBe(true);
    expect(isAccessKey("access.system.job.rules")).toBe(true);
    expect(isAccessKey("access")).toBe(false); // bare root — needs a level
    expect(isAccessKey("customer.read.all")).toBe(false);
    expect(isAccessKey("access.system.*")).toBe(false); // wildcard not declarable
    expect(isAccessKey(42)).toBe(false);
  });
});

describe("isAccessGranted — hierarchy", () => {
  const user = (grants: string[]) => new Set(grants);

  it("absent requirement is open", () => {
    expect(isAccessGranted([], false)).toBe(true);
    expect(isAccessGranted([], false, "")).toBe(true);
  });

  it("exact + ancestor grants cover; siblings and descendants do not", () => {
    // A bare grant covers its whole subtree.
    expect(isAccessGranted(user(["access.system.job"]), false, "access.system.job.rules")).toBe(true);
    expect(isAccessGranted(user(["access.system.job"]), false, "access.system.job")).toBe(true);
    // A page grant does NOT climb to its module-level ancestor.
    expect(isAccessGranted(user(["access.system.job.rules"]), false, "access.system.job")).toBe(false);
    // Siblings never cover each other.
    expect(isAccessGranted(user(["access.system.job.rules"]), false, "access.system.job.runs")).toBe(false);
    // App-level grant covers the app subtree.
    expect(isAccessGranted(user(["access.crm"]), false, "access.crm.customers")).toBe(true);
  });

  it("grant-side wildcards work at every level", () => {
    expect(isAccessGranted(user(["access.system.*"]), false, "access.system.job.rules")).toBe(true);
    expect(isAccessGranted(user(["access.system.job.*"]), false, "access.system.job.rules")).toBe(true);
    expect(isAccessGranted(user(["access.*"]), false, "access.crm.anything.here")).toBe(true);
    expect(isAccessGranted(user(["access.system.*"]), false, "access.crm.x")).toBe(false);
  });

  it("is_admin implies access.system only — never business roots", () => {
    expect(isAccessGranted([], true, "access.system.settings")).toBe(true);
    expect(isAccessGranted([], true, "access.system.job.rules")).toBe(true);
    expect(isAccessGranted([], true, "access.crm.customers")).toBe(false);
    expect(isAccessGranted([], true, "access.shop")).toBe(false);
    // An explicit business grant still applies on top of admin-ness.
    expect(isAccessGranted(user(["access.crm"]), true, "access.crm.customers")).toBe(true);
  });

  it("non-access requirements fail closed", () => {
    expect(isAccessGranted(user(["customer.read.all"]), false, "customer.read.all")).toBe(false);
    expect(isAccessGranted([], true, "not-an-access-key")).toBe(false);
  });

  it("ADMIN_INHERITED_ACCESS constant is the documented system root", () => {
    expect(ADMIN_INHERITED_ACCESS).toBe("access.system");
  });
});
