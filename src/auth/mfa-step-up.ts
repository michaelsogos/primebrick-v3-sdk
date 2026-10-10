/**
 * MFA step-up for microservice endpoints.
 *
 * The action-authorization token is minted by the BE
 * (POST /api/v1/auth/mfa/step-up/*) and sent by the client in the
 * `x-mfa-action-authorization` header. Signature can be verified offline,
 * but single-use enforcement lives in `public.mfa_action_authorizations`
 * (BE-owned schema) — so the US delegates the consume to the BE via the
 * governed correlation route `auth.mfa.consume` (client-shield only, the
 * caller is a service not a user).
 *
 * Usage (rpc route):
 *   { method: "DELETE", path: "/api/v1/ai/foo/:uuid", auth: "user",
 *     permissions: [Permission.X], mfa: { action: "delete", target_resource: "ai_foo" },
 *     handler }
 */

import type { IncomingMessage } from "node:http";
import { callNats } from "../nats/nats-routes.js";
import type { AuthUser } from "./types.js";

export const MFA_ACTION_AUTH_HEADER = "x-mfa-action-authorization";
export const AUTH_MFA_CONSUME_SUBJECT = "auth.mfa.consume";

/** Route declaration: which action/resource the token must authorize. */
export interface MfaStepUpSpec {
  action: string;
  target_resource: string;
}

/** Discriminated result returned by the BE consume route. */
export type MfaConsumeResult =
  | { ok: true; user_uuid: string }
  | { ok: false; code: string };

export type MfaConsumeFn = (
  token: string,
  action: string,
  targetResource: string,
) => Promise<MfaConsumeResult>;

/**
 * The token is missing, invalid, expired, already used, bound to a
 * different action/resource, or issued for a different user. All of these
 * map to the same response contract: 403 + `mfa_step_up_required` so the
 * FE re-runs the step-up dialog.
 */
export class MfaStepUpRequiredError extends Error {
  readonly internal_code: string;
  readonly action: string;
  readonly target_resource: string;
  constructor(spec: MfaStepUpSpec, code = "MFA_STEP_UP_REQUIRED") {
    super(`MFA step-up required for ${spec.action} on ${spec.target_resource}`);
    this.name = "MfaStepUpRequiredError";
    this.internal_code = code;
    this.action = spec.action;
    this.target_resource = spec.target_resource;
  }
}

/** The BE consume route could not be reached — transient, NOT a denial. */
export class MfaConsumeUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`auth.mfa.consume unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MfaConsumeUnavailableError";
  }
}

/** Default consume: governed correlation call to the BE. */
export const consumeMfaActionAuthorization: MfaConsumeFn = async (
  token,
  action,
  targetResource,
) => {
  try {
    return await callNats<MfaConsumeResult>(AUTH_MFA_CONSUME_SUBJECT, {
      token,
      action,
      target_resource: targetResource,
    });
  } catch (err) {
    throw new MfaConsumeUnavailableError(err);
  }
};

/**
 * Assert the request carries a valid, consumable action authorization for
 * `spec`, issued for `user`. Throws MfaStepUpRequiredError (deny → FE
 * dialog) or MfaConsumeUnavailableError (transport failure → 503).
 */
export async function assertMfaStepUp(
  req: IncomingMessage,
  spec: MfaStepUpSpec,
  user: AuthUser | undefined,
  consume: MfaConsumeFn = consumeMfaActionAuthorization,
): Promise<void> {
  const token = req.headers[MFA_ACTION_AUTH_HEADER] as string | undefined;
  if (!token) throw new MfaStepUpRequiredError(spec);
  let result: MfaConsumeResult;
  try {
    result = await consume(token, spec.action, spec.target_resource);
  } catch (err) {
    if (err instanceof MfaStepUpRequiredError || err instanceof MfaConsumeUnavailableError) throw err;
    throw new MfaConsumeUnavailableError(err);
  }
  if (!result.ok) throw new MfaStepUpRequiredError(spec, result.code);
  // The token is bound to the user it was issued for — a valid token from
  // another session must not authorize this caller's action.
  if (result.user_uuid !== user?.id) {
    throw new MfaStepUpRequiredError(spec, "MFA_ACTION_TOKEN_MISMATCH");
  }
}
