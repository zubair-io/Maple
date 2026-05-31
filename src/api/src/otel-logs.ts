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

/** Active export target, or `null` when log export is off. */
interface LogTarget {
  endpoint: string; // no trailing slash
  ingestionKey: string | null;
  serviceNamespace: string;
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
  }, FLUSH_MS);
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

  try {
    await fetch(`${t.endpoint}/v1/logs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    // Swallow — a logging sink must never throw into the app. The dropped batch
    // is acceptable (same contract as OTLP BatchLogRecordProcessor on error).
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
