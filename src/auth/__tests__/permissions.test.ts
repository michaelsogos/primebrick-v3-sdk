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

  it("exposes the ROLE_MAPPING_* CRUD permissions", () => {
    expect(Permission.ROLE_MAPPING_READ_ALL).toBe("role_mapping.read.all");
    expect(Permission.ROLE_MAPPING_READ_SINGLE).toBe("role_mapping.read.single");
    expect(Permission.ROLE_MAPPING_READ_AUDIT).toBe("role_mapping.read.audit");
    expect(Permission.ROLE_MAPPING_CREATE_SINGLE).toBe("role_mapping.create.single");
    expect(Permission.ROLE_MAPPING_UPDATE_SINGLE).toBe("role_mapping.update.single");
    expect(Permission.ROLE_MAPPING_DELETE_SINGLE).toBe("role_mapping.delete.single");
  });

  it("non-sentinel const names are mechanically derived: CONST = string.toUpperCase().replaceAll('.', '_')", () => {
    for (const [key, value] of Object.entries(Permission)) {
      if (isPermissionSentinel(value)) continue;
      expect(key).toBe(value.toUpperCase().replaceAll(".", "_"));
    }
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
    expect(isPermissionSentinel("user_profile.update.single")).toBe(false);
    expect(isPermissionSentinel("customer.read.all")).toBe(false);
    expect(isPermissionSentinel(Permission.ROLE_MAPPING_CREATE_SINGLE)).toBe(false);
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

  it("includes the ROLE_MAPPING_* CRUD permissions", () => {
    const all = listNonSentinelPermissions();
    expect(all).toContain(Permission.ROLE_MAPPING_READ_ALL);
    expect(all).toContain(Permission.ROLE_MAPPING_CREATE_SINGLE);
    expect(all).toContain(Permission.ROLE_MAPPING_UPDATE_SINGLE);
    expect(all).toContain(Permission.ROLE_MAPPING_DELETE_SINGLE);
  });

  it("includes existing module permissions", () => {
    const all = listNonSentinelPermissions();
    expect(all).toContain(Permission.CUSTOMER_READ_ALL);
    expect(all).toContain(Permission.USER_PROFILE_CREATE_SINGLE);
    expect(all).toContain(Permission.ORGANIZATION_DELETE_SINGLE);
  });
});
