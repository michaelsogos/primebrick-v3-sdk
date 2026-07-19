import { describe, it, expect } from "vitest";
import { Permission, isPermissionSentinel, listNonSentinelPermissions } from "../permissions.js";

describe("Permission enum", () => {
  it("exposes the AUTHENTICATED_ADMIN sentinel", () => {
    expect(Permission.AUTHENTICATED_ADMIN).toBe("_authenticated_admin");
  });

  it("keeps the existing sentinels unchanged", () => {
    expect(Permission.PUBLIC).toBe("_public");
    expect(Permission.AUTHENTICATED_USER).toBe("_authenticated_user");
  });

  it("exposes the ROLE_MAPPINGS_* CRUD permissions", () => {
    expect(Permission.ROLE_MAPPINGS_READ_ALL).toBe("role_mappings.read.all");
    expect(Permission.ROLE_MAPPINGS_READ_SINGLE).toBe("role_mappings.read.single");
    expect(Permission.ROLE_MAPPINGS_CREATE).toBe("role_mappings.create");
    expect(Permission.ROLE_MAPPINGS_UPDATE).toBe("role_mappings.update");
    expect(Permission.ROLE_MAPPINGS_DELETE).toBe("role_mappings.delete");
  });
});

describe("isPermissionSentinel", () => {
  it("returns true for PUBLIC", () => {
    expect(isPermissionSentinel(Permission.PUBLIC)).toBe(true);
  });

  it("returns true for AUTHENTICATED_USER", () => {
    expect(isPermissionSentinel(Permission.AUTHENTICATED_USER)).toBe(true);
  });

  it("returns true for AUTHENTICATED_ADMIN", () => {
    expect(isPermissionSentinel(Permission.AUTHENTICATED_ADMIN)).toBe(true);
  });

  it("returns false for CRUD permissions", () => {
    expect(isPermissionSentinel("users.update.single")).toBe(false);
    expect(isPermissionSentinel("customers.read.all")).toBe(false);
    expect(isPermissionSentinel(Permission.ROLE_MAPPINGS_CREATE)).toBe(false);
  });

  it("returns false for unknown strings", () => {
    expect(isPermissionSentinel("BOGUS")).toBe(false);
    expect(isPermissionSentinel("")).toBe(false);
  });
});

describe("listNonSentinelPermissions", () => {
  it("excludes all three sentinels", () => {
    const all = listNonSentinelPermissions();
    expect(all).not.toContain(Permission.PUBLIC);
    expect(all).not.toContain(Permission.AUTHENTICATED_USER);
    expect(all).not.toContain(Permission.AUTHENTICATED_ADMIN);
  });

  it("includes the ROLE_MAPPINGS_* CRUD permissions", () => {
    const all = listNonSentinelPermissions();
    expect(all).toContain(Permission.ROLE_MAPPINGS_READ_ALL);
    expect(all).toContain(Permission.ROLE_MAPPINGS_CREATE);
    expect(all).toContain(Permission.ROLE_MAPPINGS_UPDATE);
    expect(all).toContain(Permission.ROLE_MAPPINGS_DELETE);
  });

  it("includes existing module permissions", () => {
    const all = listNonSentinelPermissions();
    expect(all).toContain(Permission.CUSTOMERS_READ_ALL);
    expect(all).toContain(Permission.USERS_CREATE_SINGLE);
    expect(all).toContain(Permission.ORGANIZATIONS_DELETE_SINGLE);
  });
});
