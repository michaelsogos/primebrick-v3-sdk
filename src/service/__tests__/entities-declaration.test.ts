import { describe, expect, it } from "vitest";
import { validateEntitiesDeclaration } from "../entities-declaration.js";

/**
 * `endpoints.entities` enrollment gate — the entity→service map served on
 * /modules derives entity api bases from this document, so a malformed
 * declaration must be rejected before it reaches service_registry.
 */
describe("validateEntitiesDeclaration", () => {
  it("accepts undefined/null — optional axis (headless or route-less services)", () => {
    expect(validateEntitiesDeclaration("svc", undefined)).toBeNull();
    expect(validateEntitiesDeclaration("svc", null)).toBeNull();
  });

  it("accepts a well-formed entity name list", () => {
    expect(
      validateEntitiesDeclaration("job", ["job_trigger", "job_schedule", "job_run"]),
    ).toBeNull();
  });

  it("rejects non-array declarations", () => {
    for (const decl of ["job_schedule", 42, { entities: [] }, true]) {
      expect(validateEntitiesDeclaration("svc", decl), String(decl)).toMatch(
        /must be an array/,
      );
    }
  });

  it("rejects non-string and non-snake_case entries", () => {
    for (const e of [42, "JobSchedule", "job-schedule", "job schedule", "_hidden", "job..x", "camelCase"]) {
      expect(
        validateEntitiesDeclaration("svc", [e]),
        String(e),
      ).toMatch(/snake_case entity api name/);
    }
  });

  it("rejects duplicate entries — one owner claim per name", () => {
    expect(
      validateEntitiesDeclaration("svc", ["job_run", "job_run"]),
    ).toMatch(/duplicate entity "job_run"/);
  });

  it("accepts an empty array — a service that owns nothing yet", () => {
    expect(validateEntitiesDeclaration("svc", [])).toBeNull();
  });
});
