/**
 * OpenTelemetry → SigNoz wiring for the Maple API backend.
 *
 * The backend ships its own traces + logs to SigNoz over OTLP/HTTP. The
 * effective config is resolved DB → env → default by
 * `observability/observability-config.repo.ts`; this module turns a resolved
 * config into a running `NodeSDK` and exposes a hot-reconfigure path so the
 * operator can flip telemetry on/off (or re-point the endpoint) from
 * `PUT /api/observability/config` without a process restart.
 *
 * Signals:
 *   - Traces: OTLP/HTTP trace exporter → `${endpoint}/v1/traces`. Sampled by a
 *     parent-based ratio sampler driven by `sample_ratio`. Carried by a
 *     traces-only `NodeSDK` (started only when `traces_enabled`).
 *   - Logs:   shipped by `otel-logs.ts`, which taps pino's output stream
 *     directly (wired in `log.ts` via `pino.multistream`) and POSTs OTLP/JSON
 *     to `${endpoint}/v1/logs`. This replaces `@opentelemetry/instrumentation-
 *     pino`, whose require-in-the-middle monkey-patch is unreliable under Bun
 *     and missed every line logged before the SDK started (the whole startup
 *     sequence). `startSdk` / `stopSdk` drive it via `setOtelLogTarget`.
 *
 * Backend telemetry goes DIRECT to SigNoz (the server holds the ingestion key).
 * Client telemetry instead proxies through `POST /api/observability/otlp/*`.
 *
 * Instrumentation: HTTP (inbound/outbound) + MongoDB, so every request and DB
 * call becomes a span without manual annotation.
 *
 * Metrics are intentionally NOT wired here. `metrics_enabled` defaults off and
 * there's no metrics exporter today; the flag is plumbed through the config so
 * the surface is ready, but turning it on is a no-op until a metrics pipeline
 * lands (tracked separately). Traces + logs are the signals this ticket ships.
 *
 * The `signoz-access-token` header carries the ingestion key when one is set.
 * When `enabled` is false or `endpoint` is null, init is a no-op (and
 * `applyOtelConfig` shuts any running SDK down). All three entry points are
 * idempotent and safe to call repeatedly.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE } from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { child as childLogger } from './log.ts';
import { setOtelLogTarget } from './otel-logs.ts';
import type { ResolvedObservabilityConfig } from './observability/observability-config.repo.ts';

const log = childLogger('otel');

/** Fixed `service.name` for the API backend. The web + native clients report
 * their own service names; `service.namespace` (operator-configurable) groups
 * them. */
const SERVICE_NAME = 'maple-api';

/** Which process this SDK runs in. Picks the export cadence below. */
export type OtelTier = 'api' | 'worker';

/**
 * Export cadence per process tier (#2196).
 *
 * The worker tier hosts native code — libraw, onnxruntime, the Rust core —
 * that can abort the whole process (Rust `panic=abort`, a C++ `terminate`,
 * `bad_alloc`). SIGABRT/SIGSEGV never reach `process.on(...)`, so there is
 * no hook from which to flush: whatever the batch processors hold at that
 * instant dies with the process. The only lever is how much they hold, so
 * the worker exports on a short cadence and its loss window is bounded by
 * these numbers rather than by the SDK's 5 s span delay and the log
 * bridge's 2 s. The API process keeps the defaults: it does not host
 * native code, and its graceful shutdown drains the exporters.
 */
const TIER_EXPORT_CADENCE: Record<OtelTier, { spanDelayMs: number; logFlushMs: number }> = {
  api: { spanDelayMs: 5_000, logFlushMs: 2_000 },
  worker: { spanDelayMs: 1_000, logFlushMs: 500 },
};

/** Upper bound on a dying process waiting for its exporters. A collector
 * that is slow or down must not turn an exit into a hang; the parent's
 * respawn logic is waiting on this process. */
const FLUSH_BEFORE_EXIT_MS = 2_000;

/** Set once by `initOtel`; read by every later (re)start so a hot
 * reconfigure keeps the tier's cadence. */
let tier: OtelTier = 'api';

/** The single running SDK, or `null` when telemetry is off. Module-level so
 * `applyOtelConfig` / `shutdownOtel` can tear it down across calls. */
let sdk: NodeSDK | null = null;

/** Snapshot of the config the running SDK was started with. Lets
 * `applyOtelConfig` skip a pointless restart when nothing material changed
 * (the OTLP exporters + sampler are baked in at SDK construction, so any
 * change to the fields below requires a full restart). */
let activeKey: string | null = null;

/** Serialise SDK lifecycle transitions. `applyOtelConfig` can be called
 * concurrently with shutdown (a PUT racing a SIGTERM); chaining every
 * transition through this promise guarantees we never start a second SDK
 * before the first has finished shutting down. */
let transition: Promise<void> = Promise.resolve();

/** Material config fingerprint — anything that, when changed, forces an SDK
 * restart. Excludes `ingestion_key` deliberately: it IS material (it's an
 * exporter header), so it's folded in below. */
function fingerprint(c: ResolvedObservabilityConfig): string {
  return JSON.stringify({
    enabled: c.enabled,
    endpoint: c.endpoint,
    ingestion_key: c.ingestion_key,
    service_namespace: c.service_namespace,
    traces_enabled: c.traces_enabled,
    logs_enabled: c.logs_enabled,
    sample_ratio: c.sample_ratio,
  });
}

/** Whether the resolved config should produce a running SDK at all. Telemetry
 * is dormant when the master switch is off, no endpoint is configured, or no
 * exporting signal is enabled. */
function shouldRun(c: ResolvedObservabilityConfig): boolean {
  return c.enabled && c.endpoint !== null && (c.traces_enabled || c.logs_enabled);
}

/** Build (but do not start) a NodeSDK for a config known to be runnable.
 * Caller guarantees `c.endpoint` is non-null and at least one signal is on. */
function buildSdk(c: ResolvedObservabilityConfig): NodeSDK {
  const endpoint = c.endpoint as string;
  // SigNoz authenticates ingestion via the `signoz-access-token` header. Only
  // attach it when a key is set so a keyless (self-hosted, open) SigNoz still
  // accepts the export.
  const headers: Record<string, string> =
    c.ingestion_key !== null ? { 'signoz-access-token': c.ingestion_key } : {};

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_NAMESPACE]: c.service_namespace,
  });

  // Parent-based ratio sampler: honour an upstream sampling decision when one
  // exists (so a client-initiated trace stays whole), else sample the root at
  // `sample_ratio`.
  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(c.sample_ratio),
  });

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers });
  // Explicit batch processor rather than the SDK's implicit one, so the
  // tier's export cadence applies (see `TIER_EXPORT_CADENCE`).
  const spanProcessor = new BatchSpanProcessor(traceExporter, {
    scheduledDelayMillis: TIER_EXPORT_CADENCE[tier].spanDelayMs,
  });

  // Logs are NOT handled by the NodeSDK. The OTel `instrumentation-pino` bridge
  // is a require-in-the-middle monkey-patch that's unreliable under Bun and only
  // captures loggers created after the SDK starts — so it dropped the entire
  // startup sequence. We ship logs ourselves via `otel-logs.ts`, which taps
  // pino's output stream directly (see `startSdk` / `stopSdk`). This NodeSDK is
  // traces-only: HTTP + Mongo spans exported to `${endpoint}/v1/traces`.
  const instrumentations = [new HttpInstrumentation(), new MongoDBInstrumentation()];

  return new NodeSDK({
    resource,
    sampler,
    spanProcessors: [spanProcessor],
    instrumentations,
  });
}

/** Start the SDK for a runnable config. Assigns module state on success.
 * Synchronous-ish: `NodeSDK.start()` returns void but kicks off async
 * exporter setup internally; failures there surface on first export, not here,
 * so we wrap the start in try/catch and log. */
function startSdk(c: ResolvedObservabilityConfig): void {
  // Traces: NodeSDK (HTTP + Mongo spans). Only started when traces are on —
  // a logs-only config runs no NodeSDK.
  if (c.traces_enabled) {
    const next = buildSdk(c);
    next.start();
    sdk = next;
  }
  // Logs: pino-tap bridge, direct to SigNoz (the server holds the key; only
  // client telemetry proxies). `null` when logs are off.
  void setOtelLogTarget(
    c.logs_enabled
      ? {
          endpoint: c.endpoint as string,
          ingestionKey: c.ingestion_key,
          serviceNamespace: c.service_namespace,
          flushIntervalMs: TIER_EXPORT_CADENCE[tier].logFlushMs,
        }
      : null,
  );
  activeKey = fingerprint(c);
  log.info(
    {
      endpoint: c.endpoint,
      service_namespace: c.service_namespace,
      traces: c.traces_enabled,
      logs: c.logs_enabled,
      sample_ratio: c.sample_ratio,
      auth: c.ingestion_key !== null,
      tier,
      ...TIER_EXPORT_CADENCE[tier],
    },
    'OpenTelemetry started (shipping to SigNoz)',
  );
}

/** Stop the running SDK, if any. Resets module state regardless of outcome so
 * a subsequent start isn't blocked by a half-torn-down SDK. */
async function stopSdk(): Promise<void> {
  const current = sdk;
  sdk = null;
  activeKey = null;
  // ALWAYS clear the pino log tap first — independent of whether a trace
  // NodeSDK exists. A logs-only config runs no NodeSDK (`current` is null), so
  // gating this behind `current` would leave the tap exporting with the old
  // config after logs are disabled / the process shuts down. This also flushes
  // buffered records (setOtelLogTarget(null) tears the exporter down cleanly).
  await setOtelLogTarget(null);
  if (!current) return;
  try {
    await current.shutdown();
    log.info('OpenTelemetry SDK shut down');
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, 'error shutting down OTel SDK');
  }
}

/**
 * Boot-time entry point. Starts the SDK when the resolved config is runnable,
 * otherwise logs why telemetry is dormant and does nothing. Safe to call once
 * at startup; idempotent if somehow called twice (a second call with the same
 * config is a no-op via the fingerprint check in `applyOtelConfig`).
 */
export async function initOtel(
  resolved: ResolvedObservabilityConfig,
  processTier: OtelTier = 'api',
): Promise<void> {
  tier = processTier;
  await applyOtelConfig(resolved);
  if (!shouldRun(resolved)) {
    // Explain the no-op so an operator who set MAPLE_SIGNOZ_ENDPOINT but no
    // signals (or left enabled=false) isn't left guessing.
    if (!resolved.enabled) {
      log.info('Observability disabled (enabled=false) — no telemetry exported');
    } else if (resolved.endpoint === null) {
      log.info('Observability endpoint unset — no telemetry exported');
    } else {
      log.info('Observability has no signals enabled (traces+logs off) — nothing exported');
    }
  }
}

/**
 * Hot-reconfigure. Diffs the incoming config against the running SDK and:
 *   - tears the SDK down when the new config isn't runnable;
 *   - (re)starts the SDK when a material field changed;
 *   - does nothing when nothing material changed.
 *
 * Idempotent and safe to call repeatedly. All transitions are serialised
 * through a shared promise so a PUT racing a shutdown can't leave two SDKs
 * alive.
 */
export async function applyOtelConfig(resolved: ResolvedObservabilityConfig): Promise<void> {
  const run = async () => {
    if (!shouldRun(resolved)) {
      await stopSdk();
      return;
    }
    // Runnable. Skip the restart when the running SDK already matches.
    if (sdk !== null && activeKey === fingerprint(resolved)) return;
    // Replace any existing SDK (endpoint/sampler/exporters are immutable post
    // construction, so a material change means a full restart).
    await stopSdk();
    try {
      startSdk(resolved);
    } catch (err) {
      // A failure to construct/start the SDK must not take the process down —
      // the API keeps serving without telemetry. Reset state so a later
      // apply can retry cleanly.
      sdk = null;
      activeKey = null;
      log.error(
        { err: err instanceof Error ? err.message : err },
        'failed to start OpenTelemetry SDK — continuing without telemetry',
      );
    }
  };
  // Chain onto the in-flight transition so lifecycle ops never interleave.
  transition = transition.then(run, run);
  return transition;
}

/** Shut the SDK down (call on server shutdown). Idempotent — a no-op when
 * telemetry is already off. Serialised through the same transition chain. */
export async function shutdownOtel(): Promise<void> {
  transition = transition.then(stopSdk, stopSdk);
  return transition;
}

/**
 * Drain the exporters before the process exits, bounded by
 * `FLUSH_BEFORE_EXIT_MS` so a slow or absent collector can never turn an
 * exit into a hang. For the deaths a process can see coming — SIGTERM, an
 * uncaught exception — this is what gets the last seconds of spans and
 * logs out of the door (#2196). It cannot help with a native abort, which
 * never runs another line of JS; see `TIER_EXPORT_CADENCE` for that case.
 */
export async function flushOtelBeforeExit(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_BEFORE_EXIT_MS);
  });
  try {
    await Promise.race([shutdownOtel(), deadline]);
  } finally {
    // A flush that finishes early must not leave the deadline timer holding
    // the event loop open for the remainder of the bound.
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Route the two process deaths JS can still observe — an uncaught
 * exception and an unhandled rejection — through a telemetry flush before
 * exiting non-zero. Installing a handler suppresses the runtime's own
 * stderr report, so the error is written there explicitly first: the
 * parent folds this process's stderr tail into its structured crash log
 * (#899), and that report must keep naming the cause.
 */
export function installOtelFatalFlush(): void {
  let dying = false;
  const die = (kind: string, err: unknown): void => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[${kind}] ${detail}\n`);
    // A second fatal while the first flush is in flight changes nothing: the
    // first one exits the process when its flush settles.
    if (dying) return;
    dying = true;
    log.fatal({ err, kind }, 'process dying — flushing telemetry');
    void flushOtelBeforeExit().finally(() => process.exit(1));
  };
  process.on('uncaughtException', (err) => die('uncaughtException', err));
  process.on('unhandledRejection', (reason) => die('unhandledRejection', reason));
}
