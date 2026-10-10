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

const KEY = Symbol.for("primebrick.sdk.lifecycle-registry");

export interface LifecycleRegistry {
  /**
   * NATS subscriptions keyed by `subject::queue` — NatsClient.subscribe/
   * subscribeRequest replace the previous entry instead of stacking one
   * subscription per hot reload.
   */
  natsSubscriptions?: Map<string, { unsubscribe(): void }>;
  /** Currently-installed signal/crash listeners, for replacement. */
  signalListeners?: Array<{
    event: string;
    fn: (...args: any[]) => void;
  }>;
}

export function lifecycleRegistry(): LifecycleRegistry {
  const g = globalThis as Record<symbol, LifecycleRegistry | undefined>;
  return (g[KEY] ??= {});
}
