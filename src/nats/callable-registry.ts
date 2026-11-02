/**
 * Callable registry — module-level collection of the service's LISTEN
 * subjects that carry a payload contract. `makeNatsRoutes` and
 * `makeNatsRequestRoute` record every route declared with `payload_schema`;
 * `createMicroservice` publishes the snapshot as `endpoints.callables` on
 * the post-onReady re-register. The catalog IS the subscription table —
 * a callable can only exist where a real route does, so it can never
 * advertise a dead queue.
 */
import type { CallableDecl } from "../service/callables-declaration.js";

const callables: CallableDecl[] = [];

/** Called by the route factories — records a callable route (idempotent by subject). */
export function recordCallable(decl: CallableDecl): void {
  const idx = callables.findIndex((c) => c.subject === decl.subject);
  if (idx === -1) callables.push(decl);
  else callables[idx] = decl;
}

/** Live snapshot read by createMicroservice after `onReady` subscriptions run. */
export function snapshotCallables(): readonly CallableDecl[] {
  return callables;
}
