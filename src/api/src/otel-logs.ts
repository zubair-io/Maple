/**
 * Backend pino → SigNoz log bridge (OTLP/JSON over HTTP).
 *
 * Replaces `@opentelemetry/instrumentation-pino`, whose require-in-the-middle
 * monkey-patch is unreliable under Bun AND only captures pino loggers created
 * AFTER the SDK starts — so it silently dropped every line emitted before the
 * background boot called `initOtel` (the entire startup sequence). This module
 * instead taps pino's own output stream: `log.ts` adds `otelLogStream` as a
 * second `pino.multistream` destination, so EVERY record pino writes is seen
 * here regardless of when it was logged or which logger emitted it.
 *
 * The stream is inert until `setOtelLogTarget()` is called with a runnable
 * config (done by `otel.ts` when the SDK starts). Records are batched and
 * POSTed to `${endpoint}/v1/logs` as OTLP/JSON with the `signoz-access-token`
 * header. Backend logs go DIRECT to SigNoz (the server holds the key) — unlike
 * client telemetry, which proxies through `/api/observability/otlp/*`.
 */

const SERVICE_NAME = 'maple-api';

/** SigNoz's OTLP/HTTP receiver defaults to :4318. A wrong port (UI/query 3301/
 * 8080, or gRPC 4317) answers HTTP but isn't the collector, so exports fail
 * with a 404 while everything "looks" configured. When a failing endpoint uses
 * one of those ports we append a "use :4318" hint to the diagnostic. */
const OTLP_HTTP_DEFAULT_PORT = '4318';
const NON_OTLP_PORTS = new Set(['3301', '8080', '4317', '80', '443']);

function portHint(endpoint: string): string {
  let port = '';
  try {
    port = new URL(endpoint).port;
  } catch {
    return '';
  }
  if (port === '' || port === OTLP_HTTP_DEFAULT_PORT) return '';
  if (NON_OTLP_PORTS.has(port)) {
    return ` — port :${port} is not SigNoz's OTLP/HTTP receiver (that's usually the UI/query or gRPC port); use :${OTLP_HTTP_DEFAULT_PORT}`;
  }
  return ` — port :${port} is unusual for OTLP/HTTP (SigNoz defaults to :${OTLP_HTTP_DEFAULT_PORT})`;
}

/** Active export target, or `null` when log export is off. */
interface LogTarget {
  endpoint: string; // no trailing slash
  ingestionKey: string | null;
  serviceNamespace: string;
  /** How long a record may sit in the buffer before it is POSTed. Set per
   * process tier by `otel.ts` (#2196): the worker tier hosts native code
   * that can abort the process with no JS hook, and everything buffered at
   * that instant is lost — so it runs a much shorter cadence than the API
   * process. Defaults to `FLUSH_MS`. */
  flushIntervalMs?: number;
}

let target: LogTarget | null = null;

/** pino numeric level → OTel severityNumber + text. */
function severity(level: number): { number: number; text: string } {
  if (level >= 60) return { number: 21, text: 'FATAL' };
  if (level >= 50) return { number: 17, text: 'ERROR' };
  if (level >= 40) return { number: 13, text: 'WARN' };
  if (level >= 30) return { number: 9, text: 'INFO' };
  if (level >= 20) return { number: 5, text: 'DEBUG' };
  return { number: 1, text: 'TRACE' };
}

/** One OTLP log record (OTLP/JSON shape). */
interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: { key: string; value: { stringValue: string } }[];
}

// Reserved pino fields that map to OTLP record slots rather than attributes.
const RESERVED = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);

const BATCH_MAX = 256;
const FLUSH_MS = 2000;

let buffer: OtlpLogRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Diagnostics for a failing export. A logging sink must never throw into the
// app, but it also must not fail SILENTLY — a swallowed error here is exactly
// why "no logs in SigNoz" is undebuggable. We surface failures on `console.*`
// (NOT pino — that would feed back through this very stream and loop), throttled
// so a persistently-bad endpoint doesn't spam stderr every flush.
let consecutiveFailures = 0;
let lastFailureLogMs = 0;
const FAILURE_LOG_THROTTLE_MS = 30_000;

function reportFailure(detail: string): void {
  consecutiveFailures += 1;
  const now = Date.now();
  // Always log the first failure of a streak immediately; throttle the rest.
  if (consecutiveFailures === 1 || now - lastFailureLogMs >= FAILURE_LOG_THROTTLE_MS) {
    lastFailureLogMs = now;
    console.error(
      `[otel-logs] SigNoz log export failing (${consecutiveFailures} consecutive): ${detail}`,
    );
  }
}

function reportRecovery(): void {
  if (consecutiveFailures > 0) {
    console.error(`[otel-logs] SigNoz log export recovered after ${consecutiveFailures} failures`);
    consecutiveFailures = 0;
  }
}

/** Convert a parsed pino record to an OTLP log record. Non-string attribute
 * values are JSON-stringified so the OTLP/JSON `stringValue` shape always
 * holds (keeps the exporter simple; SigNoz indexes them as strings). */
function toOtlp(rec: Record<string, unknown>): OtlpLogRecord {
  const level = typeof rec.level === 'number' ? rec.level : 30;
  const sev = severity(level);
  const timeMs = typeof rec.time === 'number' ? rec.time : Date.now();
  const attributes: OtlpLogRecord['attributes'] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (RESERVED.has(k) || v === undefined || v === null) continue;
    const stringValue = typeof v === 'string' ? v : JSON.stringify(v);
    attributes.push({ key: k, value: { stringValue } });
  }
  return {
    timeUnixNano: String(BigInt(Math.round(timeMs)) * 1_000_000n),
    severityNumber: sev.number,
    severityText: sev.text,
    body: { stringValue: typeof rec.msg === 'string' ? rec.msg : '' },
    attributes,
  };
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, target?.flushIntervalMs ?? FLUSH_MS);
  // Don't keep the event loop alive purely for a pending flush (so the process
  // can exit between batches). `unref` exists on Node/Bun timers.
  (flushTimer as { unref?: () => void }).unref?.();
}

/** POST the current buffer to `${endpoint}/v1/logs`. Best-effort: on failure
 * the batch is dropped (telemetry must never crash the app or block logging),
 * matching how OTLP batch exporters treat a failed export. */
export async function flush(): Promise<void> {
  const t = target;
  if (!t || buffer.length === 0) return;
  const records = buffer;
  buffer = [];

  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: SERVICE_NAME } },
            { key: 'service.namespace', value: { stringValue: t.serviceNamespace } },
          ],
        },
        scopeLogs: [{ scope: { name: 'maple-api-pino' }, logRecords: records }],
      },
    ],
  };

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (t.ingestionKey) headers['signoz-access-token'] = t.ingestionKey;

  const url = `${t.endpoint}/v1/logs`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // A non-2xx means SigNoz rejected the batch (wrong port/path → 404,
      // bad/missing key → 401/403, malformed payload → 400). The batch is
      // dropped (same contract as OTLP BatchLogRecordProcessor), but we make
      // the failure visible so "no logs in SigNoz" is diagnosable. A 404 is
      // very often the wrong port, so lead with the :4318 hint.
      const hint = res.status === 404 ? portHint(t.endpoint) : '';
      const bodyPreview = (await res.text().catch(() => '')).slice(0, 200);
      reportFailure(
        `POST ${url} → HTTP ${res.status}${hint}${bodyPreview ? ` — ${bodyPreview}` : ''}`,
      );
    } else {
      reportRecovery();
    }
  } catch (err) {
    // Transport error (DNS, connection refused, TLS). Never throw into the app
    // — a logging sink must stay silent to the caller — but surface it on
    // stderr so a misconfigured endpoint is debuggable.
    reportFailure(`POST ${url} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * pino multistream destination. pino writes newline-delimited JSON; we parse
 * each line, convert it, and enqueue for the next batch. Implemented as a
 * minimal object with `write` (pino's stream contract) so there's no Node
 * stream machinery to keep the event loop alive.
 */
export const otelLogStream = {
  write(line: string): void {
    if (target === null) return; // inert until a target is configured
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON line (shouldn't happen) — skip
    }
    buffer.push(toOtlp(rec));
    if (buffer.length >= BATCH_MAX) {
      void flush();
    } else {
      scheduleFlush();
    }
  },
};

/** Enable/disable + (re)point log export. Called by `otel.ts`:
 *   - a config → start shipping logs to that endpoint;
 *   - `null`   → stop (flush whatever's buffered first). */
export async function setOtelLogTarget(next: LogTarget | null): Promise<void> {
  if (next === null) {
    await flush();
    target = null;
    return;
  }
  target = { ...next, endpoint: next.endpoint.replace(/\/+$/, '') };
}
