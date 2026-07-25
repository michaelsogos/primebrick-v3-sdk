import { describe, it, expect } from "vitest";
import { checkRbac } from "../rbac.js";
import { Permission } from "../permissions.js";
import type { AuthUser } from "../types.js";

/** Build a minimal AuthUser for tests. */
function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "uuid-1",
    idp_code: "idp-1",
    email: "u@example.com",
    name: "u",
    roles: [],
    permissions: new Set<string>(),
    isAdmin: false,
    isSystem: false,
    idp_org: null,
    idp_username: null,
    ...overrides,
  } as AuthUser;
}

describe("checkRbac — AUTHENTICATED_USER vs AUTHENTICATED_ADMIN", () => {
  const nonAdmin = makeUser({ isAdmin: false });
  const admin = makeUser({ isAdmin: true });

  it("AUTHENTICATED_USER allows a non-admin authenticated user", () => {
    const result = checkRbac(nonAdmin, [Permission.AUTHENTICATED_USER]);
    expect(result.allowed).toBe(true);
  });

  it("AUTHENTICATED_ADMIN denies a non-admin authenticated user", () => {
    const result = checkRbac(nonAdmin, [Permission.AUTHENTICATED_ADMIN]);
    expect(result.allowed).toBe(false);
  });

  it("AUTHENTICATED_USER allows an admin user", () => {
    const result = checkRbac(admin, [Permission.AUTHENTICATED_USER]);
    expect(result.allowed).toBe(true);
  });

  it("AUTHENTICATED_ADMIN allows an admin user", () => {
    const result = checkRbac(admin, [Permission.AUTHENTICATED_ADMIN]);
    expect(result.allowed).toBe(true);
  });

  it("AUTHENTICATED_ADMIN does NOT fall through to pattern matching for a non-admin with USERS_UPDATE_SINGLE", () => {
    // A non-admin who happens to hold users.update.single must NOT pass the
    // admin-only gate. The sentinel short-circuits before pattern matching.
    const nonAdminWithUpdate = makeUser({
      isAdmin: false,
      permissions: new Set(["users.update.single"]),
    });
    const result = checkRbac(nonAdminWithUpdate, [Permission.AUTHENTICATED_ADMIN]);
    expect(result.allowed).toBe(false);
  });

  it("AUTHENTICATED_USER does NOT grant admin-only access to a non-admin", () => {
    // Symmetric check: holding AUTHENTICATED_USER must not imply AUTHENTICATED_ADMIN.
    const result = checkRbac(nonAdmin, [Permission.AUTHENTICATED_ADMIN]);
    expect(result.allowed).toBe(false);
  });
});

describe("checkRbac — sentinel isolation", () => {
  it("PUBLIC always allows, even for a non-admin", () => {
    const result = checkRbac(makeUser({ isAdmin: false }), [Permission.PUBLIC]);
    expect(result.allowed).toBe(true);
  });

  it("system API key (isSystem) bypasses AUTHENTICATED_ADMIN", () => {
    // System keys are trusted infrastructure; they bypass all checks.
    const systemUser = makeUser({ isSystem: true, isAdmin: false });
    const result = checkRbac(systemUser, [Permission.AUTHENTICATED_ADMIN]);
    expect(result.allowed).toBe(true);
  });
});
