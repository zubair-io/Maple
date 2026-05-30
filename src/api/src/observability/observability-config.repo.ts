/**
 * Persisted observability (SigNoz / OpenTelemetry) runtime config. Mirrors the
 * enrichment-config shape: a single document in `app_settings` keyed by
 * `_id: "observability"`.
 *
 * The values here override the env vars (`MAPLE_SIGNOZ_ENDPOINT`,
 * `MAPLE_SIGNOZ_INGESTION_KEY`, `MAPLE_SIGNOZ_ENABLED`, the
 * `MAPLE_SIGNOZ_{TRACES,LOGS,METRICS}_ENABLED` family,
 * `MAPLE_SIGNOZ_SERVICE_NAMESPACE`, `MAPLE_SIGNOZ_SAMPLE_RATIO`) at boot —
 * env vars stay as a fallback so existing deployments don't break when no
 * row has been written yet.
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
 * saved an explicit value — the resolver then falls back to env / default.
 */
export interface ObservabilityConfig {
  /** Master switch. When false, the backend ships nothing and clients are
   * told telemetry is disabled. `null`/missing → resolver default true. */
  enabled?: boolean | null;
  /** OTLP/HTTP base URL (no trailing slash). `null`/missing → falls back to
   * `MAPLE_SIGNOZ_ENDPOINT` / unset. No endpoint → telemetry is a no-op. */
  endpoint?: string | null;
  /** SigNoz ingestion key. Secret: persisted but sent only to authenticated
   * clients (Direct-to-SigNoz transport needs it). `null`/missing → falls
   * back to `MAPLE_SIGNOZ_INGESTION_KEY`. */
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
 * boot of a fresh database). The caller should fall back to env vars. */
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
 * Resolve the effective config: DB row wins; missing fields fall back to env
 * vars; missing env vars fall back to defaults (no endpoint → telemetry
 * dormant; enabled/traces/logs default true, metrics default false). Pure
 * function — no side effects, easy to test.
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
   * whether they're seeing a saved value or an env-var fallback. */
  source: {
    enabled: 'db' | 'env' | 'default';
    endpoint: 'db' | 'env' | 'unset';
    ingestion_key: 'db' | 'env' | 'unset';
    service_namespace: 'db' | 'env' | 'default';
    traces_enabled: 'db' | 'env' | 'default';
    logs_enabled: 'db' | 'env' | 'default';
    metrics_enabled: 'db' | 'env' | 'default';
    sample_ratio: 'db' | 'env' | 'default';
  };
}

/** Resolve a boolean field with DB → env → default precedence. The env value
 * is "true" unless the string is exactly `"false"` — matching the geocode
 * worker's permissive convention (any non-"false" value enables). */
function resolveBool(
  dbVal: boolean | null | undefined,
  envVal: string | undefined,
  def: boolean,
): { value: boolean; source: 'db' | 'env' | 'default' } {
  if (typeof dbVal === 'boolean') return { value: dbVal, source: 'db' };
  if (envVal !== undefined) return { value: envVal !== 'false', source: 'env' };
  return { value: def, source: 'default' };
}

/** Resolve a secret/URL-ish string field with DB → env → unset precedence.
 * Trims and rejects empty strings so a cleared input doesn't masquerade as a
 * saved value. */
function resolveStr(
  dbVal: string | null | undefined,
  envVal: string | undefined,
): { value: string | null; source: 'db' | 'env' | 'unset' } {
  if (typeof dbVal === 'string' && dbVal.trim().length > 0) {
    return { value: dbVal.trim(), source: 'db' };
  }
  if (typeof envVal === 'string' && envVal.trim().length > 0) {
    return { value: envVal.trim(), source: 'env' };
  }
  return { value: null, source: 'unset' };
}

export function resolveObservabilityConfig(
  db: ObservabilityConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedObservabilityConfig {
  const enabled = resolveBool(db?.enabled, env.MAPLE_SIGNOZ_ENABLED, true);

  // Endpoint: DB → env → unset. Normalise both paths through validateHttpUrl
  // so a stray trailing slash or whitespace can't leak into the exporter URL.
  // An invalid value (bad protocol / unparseable) resolves to unset rather
  // than throwing — the route validates on write, so a bad value here means a
  // hand-edited DB row or env var, and the safe degradation is "no telemetry".
  let endpoint: string | null = null;
  let endpointSource: ResolvedObservabilityConfig['source']['endpoint'] = 'unset';
  if (db && typeof db.endpoint === 'string' && db.endpoint.trim().length > 0) {
    const v = validateHttpUrl(db.endpoint);
    if (typeof v === 'string') {
      endpoint = v;
      endpointSource = 'db';
    }
  }
  if (endpoint === null && env.MAPLE_SIGNOZ_ENDPOINT && env.MAPLE_SIGNOZ_ENDPOINT.length > 0) {
    const v = validateHttpUrl(env.MAPLE_SIGNOZ_ENDPOINT);
    if (typeof v === 'string') {
      endpoint = v;
      endpointSource = 'env';
    }
  }

  const ingestionKey = resolveStr(db?.ingestion_key, env.MAPLE_SIGNOZ_INGESTION_KEY);

  let serviceNamespace = DEFAULT_SERVICE_NAMESPACE;
  let serviceNamespaceSource: ResolvedObservabilityConfig['source']['service_namespace'] =
    'default';
  if (db && typeof db.service_namespace === 'string' && db.service_namespace.trim().length > 0) {
    serviceNamespace = db.service_namespace.trim();
    serviceNamespaceSource = 'db';
  } else if (env.MAPLE_SIGNOZ_SERVICE_NAMESPACE && env.MAPLE_SIGNOZ_SERVICE_NAMESPACE.length > 0) {
    serviceNamespace = env.MAPLE_SIGNOZ_SERVICE_NAMESPACE.trim();
    serviceNamespaceSource = 'env';
  }

  const traces = resolveBool(db?.traces_enabled, env.MAPLE_SIGNOZ_TRACES_ENABLED, true);
  const logs = resolveBool(db?.logs_enabled, env.MAPLE_SIGNOZ_LOGS_ENABLED, true);
  const metrics = resolveBool(db?.metrics_enabled, env.MAPLE_SIGNOZ_METRICS_ENABLED, false);

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
  } else if (env.MAPLE_SIGNOZ_SAMPLE_RATIO) {
    const parsed = Number(env.MAPLE_SIGNOZ_SAMPLE_RATIO);
    if (Number.isFinite(parsed) && parsed >= MIN_SAMPLE_RATIO && parsed <= MAX_SAMPLE_RATIO) {
      sampleRatio = parsed;
      sampleRatioSource = 'env';
    }
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
