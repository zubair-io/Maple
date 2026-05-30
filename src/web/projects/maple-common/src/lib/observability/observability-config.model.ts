// Observability (SigNoz/OpenTelemetry) config — wire shape returned by
// `GET /api/observability/config`. Mirrors the snake_case the Bun API ships.
//
// The web client pulls this config, caches it to IndexedDB (so startup isn't
// blocked on the network), and initialises the OpenTelemetry web SDK to export
// traces + logs directly to the self-hosted SigNoz OTLP/HTTP endpoint.

/** Where each resolved field came from — surfaced in the Settings UI so the
 * operator can see whether a value was set in the DB, fell back to an env var,
 * or is unset. The API may add keys, so the record is open-ended. */
export interface ObservabilityConfigSource {
  endpoint: 'db' | 'env' | 'unset';
  ingestion_key: 'db' | 'env' | 'unset';
  [key: string]: 'db' | 'env' | 'unset' | string;
}

export interface ObservabilityConfigResponse {
  /** Master switch. When false the client tears down any live SDK and exports
   * nothing, regardless of the other fields. */
  enabled: boolean;
  /** OTLP/HTTP base URL (e.g. `https://signoz.example.com:4318`). Traces post
   * to `${endpoint}/v1/traces`, logs to `${endpoint}/v1/logs`. `null` when the
   * operator hasn't configured an endpoint — the client then stays dormant. */
  endpoint: string | null;
  /** SigNoz ingestion key, sent as the `signoz-access-token` header. `null`
   * when unset (a self-hosted SigNoz with no ingestion auth doesn't need it). */
  ingestion_key: string | null;
  /** `service.namespace` resource attribute. */
  service_namespace: string;
  traces_enabled: boolean;
  logs_enabled: boolean;
  /** Metrics are not exported from the web client today — the field is read
   * so the Settings UI can surface it, but no meter provider is wired. */
  metrics_enabled: boolean;
  /** Trace head-sampling ratio in `[0, 1]`. `1.0` keeps every trace. */
  sample_ratio: number;
  source: ObservabilityConfigSource;
}

/** Returns true when two configs would produce an identical OTel runtime —
 * used to skip a needless teardown/re-init when a background refresh returns
 * the same values the cached config already initialised. */
export function observabilityConfigEqual(
  a: ObservabilityConfigResponse | null,
  b: ObservabilityConfigResponse | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.enabled === b.enabled &&
    a.endpoint === b.endpoint &&
    a.ingestion_key === b.ingestion_key &&
    a.service_namespace === b.service_namespace &&
    a.traces_enabled === b.traces_enabled &&
    a.logs_enabled === b.logs_enabled &&
    a.sample_ratio === b.sample_ratio
  );
}
