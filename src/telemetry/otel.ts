/**
 * OpenTelemetry init/restart with hot-swap support.
 *
 * Key constraint: `@opentelemetry/api` globals (tracer provider, context
 * manager, propagator) can be registered ONLY ONCE. To support config
 * changes without restarting the process we register the globals once —
 * behind a `ProxyTracerProvider` whose delegate we swap on every restart.
 *
 * - Context manager (AsyncLocalStorage) + W3C propagator are ALWAYS
 *   registered, even when telemetry is disabled: log correlation and
 *   `traceparent` propagation on NATS/HTTP must keep working.
 * - `telemetry_enabled=false` → delegate stays the built-in noop; zero
 *   exporter overhead.
 * - Auto-instrumentations are registered once, Node only (Bun's module
 *   system doesn't reliably support require-patching; Bun.serve/node:http
 *   are covered by our manual server span in `createHttpServer`).
 *
 * Config comes from `SharedConfig.telemetry` (BE-owned `config_entries`
 * rows, distributed via NATS `config.get` + `config.changed` broadcast).
 */

import { context, propagation, trace, ProxyTracerProvider, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator, CompositePropagator, W3CBaggagePropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { BasicTracerProvider, BatchSpanProcessor, type Sampler } from "@opentelemetry/sdk-trace-base";
import {
  AlwaysOnSampler,
  AlwaysOffSampler,
  TraceIdRatioBasedSampler,
  ParentBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { MsgHdrs } from "nats";
import { logger, setOtelLogSink, type LogLevel } from "../lifecycle/logger.js";

// ─── Config shape (stored in BE config_entries, shared via SharedConfig) ────

export interface TelemetryConfig {
  /** Master switch. false → no exporters, zero span overhead. */
  enabled: boolean;
  /** OTLP collector base URL, e.g. "http://collector:4318". */
  otlp_endpoint?: string;
  /** Extra headers for the collector (API keys etc.). */
  otlp_headers?: Record<string, string>;
  /** Sampler: always_on | always_off | traceidratio (default always_on). */
  sampler?: "always_on" | "always_off" | "traceidratio";
  /** Ratio for traceidratio sampler (0..1). */
  sampler_arg?: number;
}

// ─── One-time global registration ───────────────────────────────────────────

const proxyTracerProvider = new ProxyTracerProvider();
/** Empty proxy used as the "disabled" delegate — produces noop tracers. */
const noopTracerProvider = new ProxyTracerProvider();
let globalsRegistered = false;
let instrumentationsRegistered = false;

function registerGlobalsOnce(): void {
  if (globalsRegistered) return;
  globalsRegistered = true;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
  trace.setGlobalTracerProvider(proxyTracerProvider);
}

// ─── Current pipeline (swappable) ───────────────────────────────────────────

let currentTracerProvider: BasicTracerProvider | null = null;
let currentLoggerProvider: LoggerProvider | null = null;
let restartChain: Promise<void> = Promise.resolve();
let currentConfig: TelemetryConfig = { enabled: false };

function buildSampler(cfg: TelemetryConfig): Sampler {
  const ratio = cfg.sampler_arg ?? 1;
  switch (cfg.sampler) {
    case "always_off":
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "traceidratio":
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

function buildPipeline(cfg: TelemetryConfig, serviceName: string, serviceVersion: string): {
  tracer: BasicTracerProvider;
  logs: LoggerProvider;
} {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  const base = cfg.otlp_endpoint?.replace(/\/+$/, "");
  const headers = cfg.otlp_headers;

  const tracer = new BasicTracerProvider({
    resource,
    sampler: buildSampler(cfg),
    spanProcessors: base
      ? [
          new BatchSpanProcessor(
            new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }),
          ),
        ]
      : [],
  });

  const logs = new LoggerProvider({
    resource,
    processors: base
      ? [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({ url: `${base}/v1/logs`, headers }),
          }),
        ]
      : [],
  });

  return { tracer, logs };
}

async function registerInstrumentationsOnce(): Promise<void> {
  if (instrumentationsRegistered) return;
  instrumentationsRegistered = true;
  // Auto-instrumentations are Node-only — Bun's module patching is unreliable.
  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") return;
  try {
    const { registerInstrumentations } = await import("@opentelemetry/instrumentation");
    const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
    registerInstrumentations({
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disabled: our own server span in createHttpServer covers inbound
          // HTTP uniformly on Node AND Bun (avoids double spans).
          "@opentelemetry/instrumentation-http": { enabled: false },
        }),
      ],
    });
  } catch (err) {
    logger.warn("[telemetry] auto-instrumentations unavailable — continuing without them", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Initialize telemetry. Registers globals once, builds the pipeline if
 * enabled, registers Node auto-instrumentations. Safe to call once per
 * process — subsequent config changes go through `restartTelemetry`.
 */
export async function initTelemetry(
  cfg: TelemetryConfig,
  serviceName: string,
  serviceVersion: string,
): Promise<void> {
  registerGlobalsOnce();
  await registerInstrumentationsOnce();
  currentConfig = cfg;
  if (!cfg.enabled) return;
  try {
    const pipeline = buildPipeline(cfg, serviceName, serviceVersion);
    currentTracerProvider = pipeline.tracer;
    currentLoggerProvider = pipeline.logs;
    proxyTracerProvider.setDelegate(pipeline.tracer);
    setOtelLogSink(otelLogSink);
    logger.info("[telemetry] OTel pipeline started", { endpoint: cfg.otlp_endpoint ?? "none" });
  } catch (err) {
    logger.error("[telemetry] failed to start OTel pipeline — telemetry disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Rebuild the telemetry pipeline with new config — no process restart.
 * Serialized through a promise queue: concurrent restarts collapse into
 * sequential apply. Old processors shut down (flushing pending batches to
 * the OLD endpoint) before the delegate swap.
 */
export function restartTelemetry(
  cfg: TelemetryConfig,
  serviceName: string,
  serviceVersion: string,
): Promise<void> {
  restartChain = restartChain.then(async () => {
    registerGlobalsOnce();
    currentConfig = cfg;
    const oldTracer = currentTracerProvider;
    const oldLogs = currentLoggerProvider;
    try {
      if (cfg.enabled) {
        const pipeline = buildPipeline(cfg, serviceName, serviceVersion);
        currentTracerProvider = pipeline.tracer;
        currentLoggerProvider = pipeline.logs;
        proxyTracerProvider.setDelegate(pipeline.tracer);
      } else {
        currentTracerProvider = null;
        currentLoggerProvider = null;
        proxyTracerProvider.setDelegate(noopTracerProvider);
        setOtelLogSink(null);
      }
      await Promise.allSettled([oldTracer?.shutdown(), oldLogs?.shutdown()]);
      logger.info("[telemetry] OTel pipeline restarted", {
        enabled: cfg.enabled,
        endpoint: cfg.otlp_endpoint ?? "none",
      });
    } catch (err) {
      logger.error("[telemetry] restart failed — keeping previous pipeline", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return restartChain;
}

export function getTelemetryConfig(): TelemetryConfig {
  return currentConfig;
}

/** Flush pending batches + shutdown current providers (graceful shutdown). */
export async function shutdownTelemetry(): Promise<void> {
  await Promise.allSettled([
    currentTracerProvider?.shutdown(),
    currentLoggerProvider?.shutdown(),
  ]);
  currentTracerProvider = null;
  currentLoggerProvider = null;
}

// ─── OTel Logs bridge (SIEM) ────────────────────────────────────────────────

const SEVERITY: Record<LogLevel, "DEBUG" | "INFO" | "WARN" | "ERROR"> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

/** Sink registered on the async logger — forwards records to OTel Logs. */
function otelLogSink(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  const provider = currentLoggerProvider;
  if (!provider) return;
  provider.getLogger("primebrick").emit({
    severityText: SEVERITY[level],
    body: msg,
    attributes: (meta ?? {}) as Record<string, never>,
    context: context.active(),
  });
}

// ─── Propagation helpers ────────────────────────────────────────────────────

/** TextMapCarrier over NATS MsgHdrs (Map<string, string[]> wrapper). */
export const natsCarrier = {
  get(carrier: MsgHdrs, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
  set(carrier: MsgHdrs, key: string, value: string): void {
    carrier.set(key, value);
  },
  keys(carrier: MsgHdrs): string[] {
    const out: string[] = [];
    for (const [k] of carrier) out.push(k);
    return out;
  },
};

/** TextMapCarrier over plain Record<string,string> (e.g. fetch headers). */
export const recordCarrier = {
  get(carrier: Record<string, string>, key: string): string | undefined {
    return carrier[key];
  },
  set(carrier: Record<string, string>, key: string, value: string): void {
    carrier[key] = value;
  },
  keys(carrier: Record<string, string>): string[] {
    return Object.keys(carrier);
  },
};

/** Inject W3C traceparent/tracestate into a plain header record. */
export function injectTraceHeaders(hdrs: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), hdrs, recordCarrier);
  return hdrs;
}

/** Extract parent context from a plain header record (HTTP inbound). */
export function extractTraceContext(hdrs: Record<string, string | string[] | undefined>): Context {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(hdrs)) {
    if (typeof v === "string") flat[k] = v;
    else if (Array.isArray(v) && v[0]) flat[k] = v[0];
  }
  return propagation.extract(context.active(), flat, recordCarrier);
}

/** Extract parent context from NATS message headers. */
export function extractNatsContext(hdrs: MsgHdrs | undefined): Context {
  if (!hdrs) return context.active();
  return propagation.extract(context.active(), hdrs, natsCarrier);
}

/**
 * `fetch` with automatic W3C traceparent injection — for service-to-service
 * HTTP calls under runtimes where undici instrumentation is unavailable
 * (Bun). On Node, auto-instrumentation already injects; injecting again is
 * harmless (same trace context).
 */
export async function fetchTraced(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, recordCarrier);
  for (const [k, v] of Object.entries(carrier)) headers.set(k, v);
  return fetch(input, { ...init, headers });
}
