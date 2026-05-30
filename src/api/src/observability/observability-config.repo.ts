/**
 * Persisted observability (SigNoz / OpenTelemetry) runtime config. Mirrors the
 * enrichment-config shape: a single document in `app_settings` keyed by
 * `_id: "observability"`.
 *
 * Config lives ENTIRELY in the database — set it via the web Settings →
 * Observability page (or `PUT /api/observability/config`). There is no env-var
 * fallback; when no row has been written the resolver returns built-in
 * defaults (telemetry dormant until an endpoint is saved).
 *
 * Two consumers read the resolved shape:
 *   1. The API backend itself (`otel.ts`), which ships its own logs + traces
 *      to SigNoz over OTLP/HTTP.
 *   2. Authenticated web/native clients, which pull the resolved config
 *      (including the ingestion key) from `GET /api/observability/config` and
 *      send telemetry direct-to-SigNoz from the browser/app.
 */

import { getDb } from '../db/client.ts';

const COLL = 'app_settings';
const DOC_ID = 'observability';

/** Default SigNoz service namespace. Groups every Maple signal (API, web,
 * native) under one logical service tree in the SigNoz UI. */
export const DEFAULT_SERVICE_NAMESPACE = 'maple';

/** Default trace sample ratio. 1.0 = sample every trace. Tighten in
 * production via the operator surface once trace volume is understood. */
export const DEFAULT_SAMPLE_RATIO = 1.0;

/** Sample ratio bounds. A ratio outside [0, 1] is meaningless to the
 * parent-based ratio sampler and almost certainly a misconfiguration. */
export const MIN_SAMPLE_RATIO = 0;
export const MAX_SAMPLE_RATIO = 1;

/**
 * Best-effort URL validator. We accept http(s) only — OTLP/HTTP doesn't speak
 * anything else and it'd be a footgun to allow `file://` etc. Returns the
 * trimmed, trailing-slash-stripped URL, `null` for empty input, or
 * `{ error }` for an invalid value. Shared with the route so the saved value
 * and the env fallback are normalised identically (the OTLP exporters append
 * `/v1/traces` and `/v1/logs`, so the base must NOT carry a trailing slash).
 */
export function validateHttpUrl(raw: string | null): string | null | { error: string } {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Unsupported protocol: ${parsed.protocol}` };
  }
  // Strip trailing slashes so `${endpoint}/v1/traces` doesn't double up.
  return trimmed.replace(/\/+$/, '');
}

/**
 * DB shape. Every optional field is `null`/missing when the operator hasn't
 * saved an explicit value — the resolver then falls back to a built-in default.
 */
export interface ObservabilityConfig {
  /** Master switch. When false, the backend ships nothing and clients are
   * told telemetry is disabled. `null`/missing → resolver default true. */
  enabled?: boolean | null;
  /** OTLP/HTTP base URL (no trailing slash). `null`/missing → unset (no
   * endpoint → telemetry is a no-op). */
  endpoint?: string | null;
  /** SigNoz ingestion key. Secret: persisted but sent only to authenticated
   * clients (Direct-to-SigNoz transport needs it). `null`/missing → unset. */
  ingestion_key?: string | null;
  /** `service.namespace` resource attribute. `null`/missing → default. */
  service_namespace?: string | null;
  /** Per-signal toggles. `null`/missing → resolver default
   * (traces/logs on, metrics off). */
  traces_enabled?: boolean | null;
  logs_enabled?: boolean | null;
  metrics_enabled?: boolean | null;
  /** Trace sample ratio in [0, 1]. `null`/missing → default 1.0. */
  sample_ratio?: number | null;
  updated_at?: number;
}

interface ObservabilityConfigDoc {
  _id: string;
  config: ObservabilityConfig;
}

/** Read the persisted config. Returns `null` when no row exists yet (first
 * boot of a fresh database). `resolveObservabilityConfig` then supplies
 * built-in defaults. */
export async function loadObservabilityConfig(): Promise<ObservabilityConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<ObservabilityConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only the fields you supply are
 * touched, the rest of the config doc is preserved. */
export async function saveObservabilityConfig(patch: Partial<ObservabilityConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    'config.updated_at': Date.now(),
  };
  if (patch.enabled !== undefined) {
    set['config.enabled'] = patch.enabled;
  }
  if (patch.endpoint !== undefined) {
    set['config.endpoint'] = patch.endpoint;
  }
  if (patch.ingestion_key !== undefined) {
    set['config.ingestion_key'] = patch.ingestion_key;
  }
  if (patch.service_namespace !== undefined) {
    set['config.service_namespace'] = patch.service_namespace;
  }
  if (patch.traces_enabled !== undefined) {
    set['config.traces_enabled'] = patch.traces_enabled;
  }
  if (patch.logs_enabled !== undefined) {
    set['config.logs_enabled'] = patch.logs_enabled;
  }
  if (patch.metrics_enabled !== undefined) {
    set['config.metrics_enabled'] = patch.metrics_enabled;
  }
  if (patch.sample_ratio !== undefined) {
    set['config.sample_ratio'] = patch.sample_ratio;
  }
  await db.collection(COLL).updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/**
 * Resolve the effective config: DB row wins; missing fields fall back to
 * built-in defaults (no endpoint → telemetry dormant; enabled/traces/logs
 * default true, metrics default false). Pure function — no side effects, no
 * env reads, easy to test.
 */
export interface ResolvedObservabilityConfig {
  enabled: boolean;
  endpoint: string | null;
  ingestion_key: string | null;
  service_namespace: string;
  traces_enabled: boolean;
  logs_enabled: boolean;
  metrics_enabled: boolean;
  sample_ratio: number;
  /** Where each field came from. The UI renders this so the operator knows
   * whether they're seeing a saved value or a built-in default. */
  source: {
    enabled: 'db' | 'default';
    endpoint: 'db' | 'unset';
    ingestion_key: 'db' | 'unset';
    service_namespace: 'db' | 'default';
    traces_enabled: 'db' | 'default';
    logs_enabled: 'db' | 'default';
    metrics_enabled: 'db' | 'default';
    sample_ratio: 'db' | 'default';
  };
}

/** Resolve a boolean field with DB → default precedence. */
function resolveBool(
  dbVal: boolean | null | undefined,
  def: boolean,
): { value: boolean; source: 'db' | 'default' } {
  if (typeof dbVal === 'boolean') return { value: dbVal, source: 'db' };
  return { value: def, source: 'default' };
}

/** Resolve a secret/URL-ish string field with DB → unset precedence. Trims
 * and rejects empty strings so a cleared input doesn't masquerade as a saved
 * value. */
function resolveStr(dbVal: string | null | undefined): {
  value: string | null;
  source: 'db' | 'unset';
} {
  if (typeof dbVal === 'string' && dbVal.trim().length > 0) {
    return { value: dbVal.trim(), source: 'db' };
  }
  return { value: null, source: 'unset' };
}

export function resolveObservabilityConfig(
  db: ObservabilityConfig | null,
): ResolvedObservabilityConfig {
  const enabled = resolveBool(db?.enabled, true);

  // Endpoint: DB → unset. Normalise through validateHttpUrl so a stray trailing
  // slash or whitespace can't leak into the exporter URL. An invalid value
  // resolves to unset rather than throwing — the route validates on write, so a
  // bad value here means a hand-edited DB row and the safe degradation is "no
  // telemetry".
  let endpoint: string | null = null;
  let endpointSource: ResolvedObservabilityConfig['source']['endpoint'] = 'unset';
  if (db && typeof db.endpoint === 'string' && db.endpoint.trim().length > 0) {
    const v = validateHttpUrl(db.endpoint);
    if (typeof v === 'string') {
      endpoint = v;
      endpointSource = 'db';
    }
  }

  const ingestionKey = resolveStr(db?.ingestion_key);

  let serviceNamespace = DEFAULT_SERVICE_NAMESPACE;
  let serviceNamespaceSource: ResolvedObservabilityConfig['source']['service_namespace'] =
    'default';
  if (db && typeof db.service_namespace === 'string' && db.service_namespace.trim().length > 0) {
    serviceNamespace = db.service_namespace.trim();
    serviceNamespaceSource = 'db';
  }

  const traces = resolveBool(db?.traces_enabled, true);
  const logs = resolveBool(db?.logs_enabled, true);
  const metrics = resolveBool(db?.metrics_enabled, false);

  let sampleRatio = DEFAULT_SAMPLE_RATIO;
  let sampleRatioSource: ResolvedObservabilityConfig['source']['sample_ratio'] = 'default';
  if (
    db &&
    typeof db.sample_ratio === 'number' &&
    Number.isFinite(db.sample_ratio) &&
    db.sample_ratio >= MIN_SAMPLE_RATIO &&
    db.sample_ratio <= MAX_SAMPLE_RATIO
  ) {
    sampleRatio = db.sample_ratio;
    sampleRatioSource = 'db';
  }

  return {
    enabled: enabled.value,
    endpoint,
    ingestion_key: ingestionKey.value,
    service_namespace: serviceNamespace,
    traces_enabled: traces.value,
    logs_enabled: logs.value,
    metrics_enabled: metrics.value,
    sample_ratio: sampleRatio,
    source: {
      enabled: enabled.source,
      endpoint: endpointSource,
      ingestion_key: ingestionKey.source,
      service_namespace: serviceNamespaceSource,
      traces_enabled: traces.source,
      logs_enabled: logs.source,
      metrics_enabled: metrics.source,
      sample_ratio: sampleRatioSource,
    },
  };
}
