/**
 * Process-wide lifecycle registry — survives hot-module-reload.
 *
 * Under `bun --hot`/`tsx watch`, project modules are re-evaluated while
 * SDK singletons (the NATS connection, `process` listeners) persist.
 * Each reload creates a NEW ServiceRegistrar/GracefulShutdown — without a
 * process-level registry, every reload would ADD one more
 * `service.gateway_online` subscription and one more set of signal
 * handlers on the same process. The fix: keep the previously-installed
 * handles on `globalThis` and let the newest instance REPLACE them.
 */

import { logger } from "./logger.js";

const KEY = Symbol.for("primebrick.sdk.lifecycle-registry");

export interface LifecycleRegistry {
  /**
   * NATS subscriptions keyed by `subject::queue` — NatsClient.subscribe/
   * subscription replace the previous entry instead of stacking one
   * subscription per hot reload.
   */
  natsSubscriptions?: Map<string, { unsubscribe(): void }>;
  /** Currently-installed signal/crash listeners, for replacement. */
  signalListeners?: Array<{
    event: string;
    fn: (...args: any[]) => void;
  }>;
  /** Named intervals — hot reloads replace, never stack. */
  intervals?: Map<string, ReturnType<typeof setInterval>>;
}

export function lifecycleRegistry(): LifecycleRegistry {
  const g = globalThis as Record<symbol, LifecycleRegistry | undefined>;
  return (g[KEY] ??= {});
}

/**
 * Register a named interval that survives hot-module-reload EXACTLY ONCE:
 * a previous interval under the same key is cleared before the new one is
 * installed — watch-mode reloads replace instead of accumulating ticks.
 */
export function setProcessInterval(
  key: string,
  ms: number,
  fn: () => void | Promise<void>,
): ReturnType<typeof setInterval> {
  const reg = lifecycleRegistry();
  const map = (reg.intervals ??= new Map());
  const prev = map.get(key);
  if (prev !== undefined) clearInterval(prev);
  const handle = setInterval(() => {
    void Promise.resolve()
      .then(fn)
      .catch((err) => {
        // An interval tick failure must never kill the process — log and
        // keep ticking; the next run retries the same work.
        logger.warn(`process-interval "${key}" tick failed: ${String(err)}`, { tags: ["lifecycle"] });
      });
  }, ms);
  map.set(key, handle);
  return handle;
}
