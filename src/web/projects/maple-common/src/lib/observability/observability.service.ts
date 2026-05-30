// ObservabilityService — wires the OpenTelemetry web SDK to the Self-Hosted
// SigNoz instance described by `GET /api/observability/config`.
//
// Lifecycle:
//   1. `init()` (called from an app initializer) reads the cached config out of
//      IndexedDB and, if it's enabled + has an endpoint, brings the OTel
//      providers up SYNCHRONOUSLY-ish (one IDB read, no network) so startup is
//      never blocked on the API. Telemetry starts flowing immediately on a warm
//      cache.
//   2. It then fires a background refresh against the API, writes the fresh
//      config back through the IDB cache, and — only if the wiring actually
//      changed — tears the providers down and re-initialises them.
//
// Export targets (OTLP/HTTP, direct to SigNoz):
//   traces → `${endpoint}/v1/traces`,  logs → `${endpoint}/v1/logs`
//   header `signoz-access-token: <ingestion_key>` when a key is set.
//   resource: service.name = "maple-web", service.namespace = service_namespace.
//
// Zoneless app: we deliberately use the default stack context manager (NOT
// `@opentelemetry/context-zone`) — see app.config.ts `provideZonelessChangeDetection`.

import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { trace, type Tracer } from '@opentelemetry/api';
import { logs, SeverityNumber, type Logger } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  WebTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import {
  BunApiBackendService,
  type ObservabilityTestResponse,
} from '../api/bun-api-backend.service';
import {
  OBSERVABILITY_CONFIG_CACHE,
  type ObservabilityCacheRecord,
} from './observability-config-cache';
import {
  observabilityConfigEqual,
  type ObservabilityConfigPatch,
  type ObservabilityConfigResponse,
} from './observability-config.model';

/** Fixed `service.name` for the web client — distinguishes it from the Bun API
 * and any future native shells in SigNoz. */
const SERVICE_NAME = 'maple-web';

/** Instrumentation-scope name for tracer + logger. */
const SCOPE_NAME = '@maple/web';

/** Live OTel runtime for one config. Held together so teardown is atomic. */
interface OtelRuntime {
  readonly tracerProvider: WebTracerProvider | null;
  readonly loggerProvider: LoggerProvider | null;
  /** `registerInstrumentations` returns a disposer to unregister the patched
   * `fetch`. Null when no instrumentation was registered. */
  readonly unregisterInstrumentations: (() => void) | null;
}

@Injectable({ providedIn: 'root' })
export class ObservabilityService {
  private readonly api = inject(BunApiBackendService);
  private readonly cache = inject(OBSERVABILITY_CONFIG_CACHE);

  /** The config currently driving the SDK (or the last one seen). */
  readonly config = signal<ObservabilityConfigResponse | null>(null);
  /** True once OTel providers are live (traces and/or logs exporting). */
  readonly initialized = signal(false);
  /** Last error from a refresh or an SDK setup attempt. UI surfaces it. */
  readonly lastError = signal<string | null>(null);
  /** `storedAt` of the IDB record currently applied — drives the
   * "configuration cached, last refreshed …" line in Settings. */
  readonly cachedAt = signal<number | null>(null);

  private runtime: OtelRuntime | null = null;
  private tracer: Tracer | null = null;
  private logger: Logger | null = null;
  private started = false;

  /**
   * App-initializer entry point. Resolves quickly: it awaits only the IndexedDB
   * read (fast, local) and brings OTel up from cache before the network call,
   * then schedules the refresh WITHOUT awaiting it so bootstrap proceeds.
   *
   * Idempotent — a second call is a no-op (guards against double-registration
   * if both an initializer and a component trigger it).
   */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 1. Warm-start from cache (no network).
    let cached: ObservabilityCacheRecord | null = null;
    try {
      cached = await this.cache.get();
    } catch (err) {
      // A broken cache must not block startup — log + carry on to the refresh.
      console.warn('[observability] cache read failed', err);
    }
    if (cached) {
      this.cachedAt.set(cached.storedAt);
      this.applyConfig(cached.config);
    }

    // 2. Background refresh. Fire-and-forget: never block bootstrap on the API.
    void this.refresh();
  }

  /**
   * Pull the latest config from the API, persist it, and re-wire OTel if the
   * effective configuration changed. Safe to call from the Settings page's
   * "Refresh" affordance as well as from {@link init}.
   */
  async refresh(): Promise<void> {
    let fresh: ObservabilityConfigResponse;
    try {
      fresh = await firstValueFrom(this.api.getObservabilityConfig());
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      return;
    }
    this.lastError.set(null);
    await this.ingest(fresh);
  }

  /**
   * Persist a config patch to the server (`PUT /api/observability/config`),
   * then apply the re-resolved result locally (cache + re-wire the SDK).
   * Returns the fresh config so the Settings form can reseed. Throws on
   * failure so the caller can surface it.
   */
  async saveConfig(patch: ObservabilityConfigPatch): Promise<ObservabilityConfigResponse> {
    const fresh = await firstValueFrom(this.api.saveObservabilityConfig(patch));
    this.lastError.set(null);
    await this.ingest(fresh);
    return fresh;
  }

  /** Probe an OTLP/HTTP endpoint (+ optional ingestion key) without saving —
   * backs the Settings "Test connection" button. A `null` key tells the server
   * to probe with the saved key (if one is configured). */
  testConnection(
    endpoint: string,
    ingestionKey: string | null,
  ): Promise<ObservabilityTestResponse> {
    return firstValueFrom(this.api.testObservability({ endpoint, ingestion_key: ingestionKey }));
  }

  /** Shared tail for {@link refresh} / {@link saveConfig}: persist the config
   * to IndexedDB and (re-)wire the SDK only when the effective config changed. */
  private async ingest(fresh: ObservabilityConfigResponse): Promise<void> {
    const changed = !observabilityConfigEqual(this.config(), fresh);
    try {
      await this.cache.put(fresh);
      this.cachedAt.set(Date.now());
    } catch (err) {
      console.warn('[observability] cache write failed', err);
    }
    if (changed) {
      this.applyConfig(fresh);
    } else {
      // Keep the signal pointed at the freshest object even when the wiring is
      // identical (e.g. `source` provenance may have shifted).
      this.config.set(fresh);
    }
  }

  /**
   * Public hook for the global error handler. Records the error as both an OTel
   * exception span event and a log record, so it lands in SigNoz regardless of
   * which signal the operator has enabled. No-ops silently when telemetry is
   * inert (keeps the error handler cheap on misconfigured deploys).
   */
  recordError(error: unknown, context?: Record<string, string>): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const attrs: Record<string, string> = {
      'exception.type': err.name,
      'exception.message': err.message,
      ...(err.stack ? { 'exception.stacktrace': err.stack } : {}),
      ...(context ?? {}),
    };

    if (this.tracer) {
      const span = this.tracer.startSpan('exception');
      span.recordException(err);
      span.setAttributes(attrs);
      span.end();
    }
    this.recordLog('error', err.message, attrs);
  }

  /**
   * Emit a structured log record to SigNoz. No-ops when the logger isn't live.
   * `level` maps onto the OTel severity scale.
   */
  recordLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    attrs?: Record<string, string | number | boolean>,
  ): void {
    if (!this.logger) return;
    this.logger.emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: attrs,
    });
  }

  // ── Internal wiring ────────────────────────────────────────────────────────

  /** Tear down any live providers and (re)build them from `cfg`. The single
   * choke point for every config change so teardown is never skipped. */
  private applyConfig(cfg: ObservabilityConfigResponse): void {
    this.config.set(cfg);
    this.teardown();

    const active = cfg.enabled && !!cfg.endpoint;
    if (!active) {
      this.initialized.set(false);
      return;
    }

    try {
      this.runtime = this.buildRuntime(cfg);
      this.tracer = this.runtime.tracerProvider ? trace.getTracer(SCOPE_NAME) : null;
      this.logger = this.runtime.loggerProvider ? logs.getLogger(SCOPE_NAME) : null;
      this.initialized.set(this.tracer !== null || this.logger !== null);
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      this.teardown();
      this.initialized.set(false);
    }
  }

  /** Construct the trace + log providers for an active config and register
   * them with the global OTel API so `trace.getTracer` / `logs.getLogger`
   * resolve to them. `endpoint` is guaranteed non-null by the caller. */
  private buildRuntime(cfg: ObservabilityConfigResponse): OtelRuntime {
    const endpoint = cfg.endpoint as string;
    const base = endpoint.replace(/\/+$/, '');
    const headers: Record<string, string> = cfg.ingestion_key
      ? { 'signoz-access-token': cfg.ingestion_key }
      : {};

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_NAMESPACE]: cfg.service_namespace,
      [ATTR_SERVICE_VERSION]: '0.0.0',
    });

    let tracerProvider: WebTracerProvider | null = null;
    let unregisterInstrumentations: (() => void) | null = null;
    if (cfg.traces_enabled) {
      const traceExporter = new OTLPTraceExporter({ url: `${base}/v1/traces`, headers });
      // Head sampling. ParentBased keeps a child span whenever its parent was
      // sampled, otherwise applies the ratio — the standard production sampler.
      const ratio = Number.isFinite(cfg.sample_ratio)
        ? Math.min(1, Math.max(0, cfg.sample_ratio))
        : 1;
      tracerProvider = new WebTracerProvider({
        resource,
        sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
        spanProcessors: [new BatchSpanProcessor(traceExporter)],
      });
      // Default (stack) context manager — zoneless app, see file header.
      tracerProvider.register();

      // HttpClient runs on the fetch backend (provideHttpClient(withFetch())),
      // so FetchInstrumentation turns every API call into a span automatically.
      unregisterInstrumentations = registerInstrumentations({
        tracerProvider,
        instrumentations: [new FetchInstrumentation()],
      });
    }

    let loggerProvider: LoggerProvider | null = null;
    if (cfg.logs_enabled) {
      const logExporter = new OTLPLogExporter({ url: `${base}/v1/logs`, headers });
      loggerProvider = new LoggerProvider({
        resource,
        processors: [new BatchLogRecordProcessor(logExporter)],
      });
      logs.setGlobalLoggerProvider(loggerProvider);
    }

    return { tracerProvider, loggerProvider, unregisterInstrumentations };
  }

  /** Flush + dispose the current providers and reset derived handles. Each
   * shutdown is awaited only as a fire-and-forget flush — teardown itself is
   * synchronous so a re-init can't race a half-disposed provider. */
  private teardown(): void {
    const rt = this.runtime;
    this.runtime = null;
    this.tracer = null;
    this.logger = null;
    if (!rt) return;

    rt.unregisterInstrumentations?.();
    if (rt.tracerProvider) {
      void rt.tracerProvider.shutdown().catch(() => {
        /* flush failures on teardown are non-fatal */
      });
      // Drop the global trace provider so a disabled config stops emitting.
      trace.disable();
    }
    if (rt.loggerProvider) {
      void rt.loggerProvider.shutdown().catch(() => {
        /* non-fatal */
      });
      logs.disable();
    }
  }
}

/** Maps our coarse levels onto OTel's severity scale. */
const SEVERITY: Record<'debug' | 'info' | 'warn' | 'error', SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};
