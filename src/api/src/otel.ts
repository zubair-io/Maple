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
 *     parent-based ratio sampler driven by `sample_ratio`.
 *   - Logs:   pino records are bridged to the OTel Logs SDK by
 *     `@opentelemetry/instrumentation-pino` (`disableLogSending: false`), and a
 *     batched OTLP/HTTP log exporter ships them to `${endpoint}/v1/logs`. This
 *     is the supported path for "backend logs → SigNoz" — the existing pino
 *     logger (`log.ts`) needs no changes; its records are picked up
 *     automatically once the SDK starts, and each record carries the active
 *     trace/span id for log↔trace correlation.
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
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { child as childLogger } from './log.ts';
import type { ResolvedObservabilityConfig } from './observability/observability-config.repo.ts';

const log = childLogger('otel');

/** Fixed `service.name` for the API backend. The web + native clients report
 * their own service names; `service.namespace` (operator-configurable) groups
 * them. */
const SERVICE_NAME = 'maple-api';

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

  const traceExporter = c.traces_enabled
    ? new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers })
    : undefined;

  const logRecordProcessors = c.logs_enabled
    ? [new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }))]
    : [];

  // Pino instrumentation bridges pino log records into the OTel Logs SDK
  // (disableLogSending defaults false). Combined with the log exporter +
  // processor above, every `log.*()` call in the backend lands in SigNoz,
  // tagged with the active trace/span id for correlation.
  const instrumentations = [
    new HttpInstrumentation(),
    new MongoDBInstrumentation(),
    new PinoInstrumentation(),
  ];

  return new NodeSDK({
    resource,
    sampler,
    ...(traceExporter ? { traceExporter } : {}),
    logRecordProcessors,
    instrumentations,
  });
}

/** Start the SDK for a runnable config. Assigns module state on success.
 * Synchronous-ish: `NodeSDK.start()` returns void but kicks off async
 * exporter setup internally; failures there surface on first export, not here,
 * so we wrap the start in try/catch and log. */
function startSdk(c: ResolvedObservabilityConfig): void {
  const next = buildSdk(c);
  next.start();
  sdk = next;
  activeKey = fingerprint(c);
  log.info(
    {
      endpoint: c.endpoint,
      service_namespace: c.service_namespace,
      traces: c.traces_enabled,
      logs: c.logs_enabled,
      sample_ratio: c.sample_ratio,
      auth: c.ingestion_key !== null,
    },
    'OpenTelemetry SDK started (shipping to SigNoz)',
  );
}

/** Stop the running SDK, if any. Resets module state regardless of outcome so
 * a subsequent start isn't blocked by a half-torn-down SDK. */
async function stopSdk(): Promise<void> {
  const current = sdk;
  sdk = null;
  activeKey = null;
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
export async function initOtel(resolved: ResolvedObservabilityConfig): Promise<void> {
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
