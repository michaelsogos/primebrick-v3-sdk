/**
 * `entityFieldValidator(meta)` — the server-side twin of the FE form
 * schema: validates the `{entity, translations?}` write envelope strictly
 * and runs `checkEntityFields` (core) on the entity — the SAME predicates
 * the form binds into zod. No zod here by design (the SDK stays
 * zod-free — see `config-validator.ts`): the returned value is the
 * documented `(raw) => {entity}` plain validator.
 *
 * Enforcement by default: the entity router wires this as
 * `schemas.createBody`/`updateBody` whenever the caller declares `meta`
 * and passes no explicit schema — meta-declared field rules are enforced
 * server-side without per-service wiring. A hand schema still wins.
 */

import { checkEntityFields, type EntityMeta, type FieldIssue } from "@primebrick/core";
import { ValidationError } from "./rpc-router.js";

export interface EntityFieldValidatorOptions {
  /** Update semantics — only present keys validated, absent required
   *  fields skipped. Default false (create). */
  partial?: boolean;
}

function summarize(issues: FieldIssue[]): string {
  const shown = issues
    .slice(0, 3)
    .map((i) => `${i.path}: ${i.message}`)
    .join("; ");
  return issues.length > 3 ? `${shown} (+${issues.length - 3} more)` : shown;
}

export function entityFieldValidator(
  meta: EntityMeta,
  opts: EntityFieldValidatorOptions = {},
): (body: unknown) => { entity: Record<string, unknown> } {
  return (body: unknown) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Body must be the { entity } envelope");
    }
    const env = body as Record<string, unknown>;
    const allowed = new Set(["entity", "translations"]);
    for (const key of Object.keys(env)) {
      if (!allowed.has(key)) {
        throw new ValidationError(`Body has unrecognized key "${key}"`);
      }
    }
    const entity = env.entity;
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
      throw new ValidationError("Body.entity must be an object");
    }
    const issues = checkEntityFields(
      meta,
      entity as Record<string, unknown>,
      { partial: opts.partial },
    );
    if (issues.length > 0) {
      throw new ValidationError(`Entity validation failed: ${summarize(issues)}`, "VALIDATION_ERROR", {
        issues: issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
      });
    }
    return { entity: entity as Record<string, unknown> };
  };
}
