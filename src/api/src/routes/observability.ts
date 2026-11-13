/**
 * /api/observability/* — operator-facing routes for the SigNoz / OpenTelemetry
 * observability config. The backend ships its own logs + traces to SigNoz; and
 * authenticated clients pull the resolved config (including the ingestion key)
 * to send telemetry direct-to-SigNoz.
 *
 *   GET  /api/observability/config — current effective config + sources.
 *                                    INCLUDES `ingestion_key` (Direct-to-SigNoz
 *                                    transport: authenticated clients need it).
 *   PUT  /api/observability/config — validate + save; hot-reconfigure the
 *                                    backend SDK; return the resolved config.
 *   POST /api/observability/test   — POST an empty span batch to
 *                                    `${endpoint}/v1/traces` to verify reach +
 *                                    auth without saving.
 *
 * All routes are mounted behind `requireAuth` (also embedded here so the module
 * is self-gating). `PUT /config` and `POST /test` are owner-only (#4744): the
 * first redirects every client's telemetry, the second can carry the saved
 * ingestion key — and it only ever does so to the saved endpoint, never to a
 * caller-chosen URL. Write semantics mirror the provider API keys (non-empty
 * sets, null clears to env, ""/omitted leaves unchanged) so a blank field in
 * the UI never wipes a key the operator typed once.
 */

import { Elysia, t } from 'elysia';
import { requireAuth, requireOwnerBeforeHandle } from '../auth/middleware.ts';
import { child as childLogger } from '../log.ts';
import {
  MAX_SAMPLE_RATIO,
  MIN_SAMPLE_RATIO,
  loadObservabilityConfig,
  resolveObservabilityConfig,
  saveObservabilityConfig,
  validateHttpUrl,
  type ObservabilityConfig,
  type ResolvedObservabilityConfig,
} from '../observability/observability-config.repo.ts';
import { applyOtelConfig } from '../otel.ts';

const log = childLogger('observability:routes');

/** Strip the secret ingestion key from a resolved config before it goes over
 * HTTP, replacing it with a boolean "is a key set" indicator. Clients no longer
 * talk to SigNoz directly (they POST to the `/otlp/*` proxy on this server,
 * which injects the key server-side), so the key must never leave the server.
 * `source.ingestion_key` (db / unset) is safe to keep — it's provenance, not
 * the secret. */
function toPublicConfig(resolved: ResolvedObservabilityConfig) {
  const { ingestion_key, ...safe } = resolved;
  return {
    ...safe,
    ingestion_key_set: typeof ingestion_key === 'string' && ingestion_key.length > 0,
  };
}

/** OTLP signals the proxy forwards. Anything else 404s. */
const OTLP_SIGNALS = new Set(['traces', 'logs', 'metrics']);

/** SigNoz's OTLP/HTTP receiver listens on 4318 by default. A very common
 * misconfiguration is pointing at the UI/query port (3301/8080) or the gRPC
 * port (4317), which answer HTTP but are NOT the OTLP/HTTP collector — so an
 * empty-batch probe gets a 2xx (or an HTML page) and looks "reachable" while no
 * telemetry is ever ingested. When a probe looks wrong, we surface a hint. */
const OTLP_HTTP_DEFAULT_PORT = '4318';
const NON_OTLP_PORTS = new Set(['3301', '8080', '4317', '80', '443']);

/** Build a "did you mean :4318?" recommendation for an endpoint whose port is a
 * known non-OTLP-HTTP service, or `null` when the port already looks right (or
 * is absent, so we can't tell). */
function portRecommendation(endpoint: string): string | null {
  let port: string;
  try {
    port = new URL(endpoint).port;
  } catch {
    return null;
  }
  if (port === '' || port === OTLP_HTTP_DEFAULT_PORT) return null;
  if (NON_OTLP_PORTS.has(port)) {
    return `Port :${port} is not SigNoz's OTLP/HTTP receiver — that's usually the UI/query (3301/8080) or gRPC (4317) port. Use :${OTLP_HTTP_DEFAULT_PORT} for OTLP/HTTP.`;
  }
  return `Port :${port} is unusual for OTLP/HTTP — SigNoz's OTLP/HTTP receiver defaults to :${OTLP_HTTP_DEFAULT_PORT}.`;
}

/** A real OTLP/HTTP receiver answers with an OTLP body (JSON `{}` /
 * `{"partialSuccess":…}` or protobuf), tagged `application/json` or
 * `application/x-protobuf`. The SigNoz UI port instead returns `text/html` (the
 * SPA), which `res.ok` alone can't distinguish from a real accept. Returns
 * `true` when the response content-type looks like OTLP. */
function looksLikeOtlpResponse(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('application/json') || ct.includes('application/x-protobuf');
}

const ConfigBody = t.Object({
  /** Master switch. `null` clears back to env/default; omitted leaves the
   * saved value alone. */
  enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  /** OTLP/HTTP base URL. http(s) only; `null`/empty clears back to env/unset;
   * omitted leaves the saved value alone. */
  endpoint: t.Optional(t.Union([t.String(), t.Null()])),
  /** SigNoz ingestion key. A non-empty string sets it; `null` clears it back
   * to the `MAPLE_SIGNOZ_INGESTION_KEY` env var; omitted (or empty string)
   * leaves the saved key unchanged. */
  ingestion_key: t.Optional(t.Union([t.String(), t.Null()])),
  service_namespace: t.Optional(t.Union([t.String(), t.Null()])),
  traces_enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  logs_enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  metrics_enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  /** Trace sample ratio in [0, 1]. `null` clears back to env/default; omitted
   * leaves the saved value alone. */
  sample_ratio: t.Optional(t.Union([t.Number(), t.Null()])),
});

type ConfigBodyInput = typeof ConfigBody.static;

/** Validate the two fields of a PUT that can be malformed. `endpoint`:
 * omitted = keep, `null`/empty = clear, otherwise an http(s) URL normalised
 * without trailing slashes (`${endpoint}/v1/traces` must not double up).
 * `sample_ratio`: omitted = keep, `null` = clear, otherwise finite in [0, 1]. */
function validateConfigBody(
  body: ConfigBodyInput,
):
  | { endpoint: string | null | undefined; sampleRatio: number | null | undefined }
  | { error: string } {
  const endpoint = body.endpoint === undefined ? undefined : validateHttpUrl(body.endpoint);
  if (endpoint !== null && typeof endpoint === 'object') {
    return { error: `Invalid endpoint: ${endpoint.error}` };
  }
  const sampleRatio = body.sample_ratio;
  if (
    typeof sampleRatio === 'number' &&
    (!Number.isFinite(sampleRatio) ||
      sampleRatio < MIN_SAMPLE_RATIO ||
      sampleRatio > MAX_SAMPLE_RATIO)
  ) {
    return {
      error: `Invalid sample_ratio: must be a number between ${MIN_SAMPLE_RATIO} and ${MAX_SAMPLE_RATIO} (got ${sampleRatio})`,
    };
  }
  return { endpoint, sampleRatio };
}

/** Turn the probe's HTTP answer into the route's verdict. A non-2xx is a
 * plain failure; a 2xx that does not look like OTLP (an HTML SPA page from
 * the UI/query port) is NOT a real accept, so it is flagged with the :4318
 * recommendation. */
function interpretProbeResponse(res: Response, portHint: string | null) {
  if (!res.ok) {
    // A 404 most often means "right host, wrong port" — the endpoint answered
    // HTTP but has no /v1/traces route. The port hint applies to any non-2xx.
    const base = `SigNoz returned HTTP ${res.status}`;
    const error = portHint ? `${base}. ${portHint}` : base;
    return { ok: false, status: res.status, error, recommendation: portHint ?? undefined };
  }
  const contentType = res.headers.get('content-type');
  if (!looksLikeOtlpResponse(contentType)) {
    return {
      ok: false,
      status: res.status,
      error:
        `Endpoint replied ${res.status} but with "${contentType ?? 'no content-type'}", not an OTLP response — this is probably not SigNoz's OTLP/HTTP receiver. ` +
        (portHint ?? `SigNoz's OTLP/HTTP receiver defaults to :${OTLP_HTTP_DEFAULT_PORT}.`),
      recommendation: portHint ?? `Use SigNoz's OTLP/HTTP port :${OTLP_HTTP_DEFAULT_PORT}.`,
    };
  }
  return { ok: true, status: res.status };
}

/** Normalise the write-only `ingestion_key` field of a PUT into a save patch.
 * `undefined`/blank leaves the saved key alone, `null` clears it, a non-empty
 * string sets it. A key is persisted together with the endpoint it is for
 * (#4744), in the same write, so no interleaving of two saves can leave a key
 * bound to an endpoint it was not typed for: the resolver drops a key whose
 * binding no longer matches. A legacy key with no binding is pinned to the
 * endpoint it is being moved away from. */
async function resolveIngestionKeyPatch(
  typed: string | null | undefined,
  endpoint: string | null | undefined,
): Promise<Pick<ObservabilityConfig, 'ingestion_key' | 'ingestion_key_endpoint'>> {
  const saved = await loadObservabilityConfig();
  return ingestionKeyPatchFor(typed, endpoint, saved, resolveObservabilityConfig(saved).endpoint);
}

/** Pure form of `resolveIngestionKeyPatch` over the row that was read. A key
 * and its binding always land in the same write: a new key carries the
 * endpoint it is for, and a legacy (unbound) key being moved away from its
 * endpoint is written back together with that binding — so a save that read
 * stale state can at worst restore the key it saw, never re-bind one that
 * landed meanwhile. */
export function ingestionKeyPatchFor(
  typed: string | null | undefined,
  endpoint: string | null | undefined,
  saved: ObservabilityConfig | null,
  savedEndpoint: string | null,
): Pick<ObservabilityConfig, 'ingestion_key' | 'ingestion_key_endpoint'> {
  if (typed === null) return { ingestion_key: null, ingestion_key_endpoint: null };
  const trimmed = typed?.trim() ?? '';
  if (trimmed.length > 0) {
    return {
      ingestion_key: trimmed,
      // Omitted endpoint = keep the saved one; an explicit null clears it and
      // the key must stay bound to "no endpoint", not to the one being cleared.
      ingestion_key_endpoint: endpoint === undefined ? savedEndpoint : endpoint,
    };
  }
  const legacyKey = saved?.ingestion_key_endpoint === undefined ? saved?.ingestion_key : undefined;
  return endpoint !== undefined && typeof legacyKey === 'string' && legacyKey.length > 0
    ? { ingestion_key: legacyKey, ingestion_key_endpoint: savedEndpoint }
    : {};
}

/** The key a `/test` probe may carry: the typed one as given, else the saved
 * one only for the saved endpoint, else none. */
async function resolveProbeKey(
  typed: string | null | undefined,
  endpoint: string,
): Promise<string | null> {
  if (typeof typed === 'string' && typed.trim().length > 0) return typed.trim();
  const saved = resolveObservabilityConfig(await loadObservabilityConfig());
  const savedKey = saved.ingestion_key?.trim() ?? '';
  return savedKey.length > 0 && saved.endpoint === endpoint ? savedKey : null;
}

const TestBody = t.Object({
  endpoint: t.String({ minLength: 1 }),
  /** Optional write-only key to probe with a not-yet-saved value. When omitted
   * the request is unauthenticated (a keyless SigNoz still accepts it). */
  ingestion_key: t.Optional(t.Union([t.String(), t.Null()])),
});

export const observabilityRoutes = new Elysia({ prefix: '/api/observability' })
  .use(requireAuth)
  .get('/config', async () => {
    // The ingestion key is NEVER returned — clients send telemetry through the
    // `/otlp/*` proxy below, which injects the key server-side. We expose only
    // `ingestion_key_set` so the UI can show whether one is configured.
    const dbConfig = await loadObservabilityConfig();
    return toPublicConfig(resolveObservabilityConfig(dbConfig));
  })

  .put(
    '/config',
    async ({ body, set }) => {
      const validated = validateConfigBody(body);
      if ('error' in validated) {
        set.status = 400;
        return { error: validated.error };
      }
      const { endpoint, sampleRatio } = validated;

      const keyPatch = await resolveIngestionKeyPatch(body.ingestion_key, endpoint);

      await saveObservabilityConfig({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...keyPatch,
        ...(body.service_namespace !== undefined
          ? { service_namespace: body.service_namespace }
          : {}),
        ...(body.traces_enabled !== undefined ? { traces_enabled: body.traces_enabled } : {}),
        ...(body.logs_enabled !== undefined ? { logs_enabled: body.logs_enabled } : {}),
        ...(body.metrics_enabled !== undefined ? { metrics_enabled: body.metrics_enabled } : {}),
        ...(sampleRatio !== undefined ? { sample_ratio: sampleRatio } : {}),
      });

      // Re-resolve from DB (env vars may contribute to fields we didn't
      // change), then hot-reconfigure the running backend SDK so the new
      // config takes effect without a restart.
      const dbConfig = await loadObservabilityConfig();
      const resolved = resolveObservabilityConfig(dbConfig);
      try {
        await applyOtelConfig(resolved);
      } catch (err) {
        // applyOtelConfig swallows its own start failures (it logs + degrades
        // to no-telemetry), so this catch is for the unexpected. The DB row is
        // already saved; the SDK reconfigures on next boot.
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'applyOtelConfig failed after save');
      }

      return toPublicConfig(resolved);
    },
    { body: ConfigBody, beforeHandle: requireOwnerBeforeHandle },
  )

  .post(
    '/test',
    async ({ body, set }) => {
      const validated = validateHttpUrl(body.endpoint);
      if (validated === null) {
        set.status = 400;
        return { ok: false, error: 'Endpoint is empty' };
      }
      if (typeof validated === 'object' && 'error' in validated) {
        set.status = 400;
        return { ok: false, error: validated.error };
      }
      // Probe the trace ingestion path with an empty span batch — the cheapest
      // request SigNoz accepts. A 2xx means the endpoint is reachable AND the
      // key (if any) authenticates.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // Auth header precedence, matching the form's "blank keeps the saved key"
      // semantics: a typed key wins; otherwise the saved DB key is used — but
      // ONLY when the probe targets the endpoint that key was saved for
      // (#4744). The field is write-only, so this is the one path the saved
      // secret can leave the server on; it must never follow a caller URL.
      const probeKey = await resolveProbeKey(body.ingestion_key, validated);
      if (probeKey) {
        headers['signoz-access-token'] = probeKey;
      }
      const portHint = portRecommendation(validated);
      try {
        const res = await fetch(`${validated}/v1/traces`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ resourceSpans: [] }),
        });
        return interpretProbeResponse(res, portHint);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Connection refused on a wrong port is also a strong signal.
        return {
          ok: false,
          error: portHint ? `${msg}. ${portHint}` : msg,
          recommendation: portHint ?? undefined,
        };
      }
    },
    { body: TestBody, beforeHandle: requireOwnerBeforeHandle },
  )

  // ── OTLP proxy ────────────────────────────────────────────────────────────
  // `POST /api/observability/otlp/v1/:signal` (signal ∈ traces|logs|metrics).
  // Clients (web, native) export telemetry HERE instead of straight to SigNoz,
  // so the ingestion key never leaves the server. We forward the raw OTLP body
  // verbatim to `${endpoint}/v1/<signal>`, injecting the `signoz-access-token`
  // header. This route is bearer-gated by the `requireAuth` wrapper it mounts
  // behind (see index.ts), so only signed-in clients can push telemetry.
  //
  // `parse: 'arrayBuffer'` so Elysia hands us the body bytes untouched — the
  // payload may be OTLP/JSON or OTLP/protobuf depending on the client exporter,
  // and we forward whichever Content-Type the client sent.
  .post(
    '/otlp/v1/:signal',
    async ({ params, body, headers, set }) => {
      const signal = params.signal;
      if (!OTLP_SIGNALS.has(signal)) {
        set.status = 404;
        return { error: `Unknown OTLP signal: ${signal}` };
      }

      const resolved = resolveObservabilityConfig(await loadObservabilityConfig());

      // Telemetry off, no endpoint, or this specific signal disabled → 503.
      // The client's batch processor will retry later; a disabled signal is not
      // an error the operator needs to see per-request.
      const signalEnabled =
        signal === 'traces'
          ? resolved.traces_enabled
          : signal === 'logs'
            ? resolved.logs_enabled
            : resolved.metrics_enabled;
      if (!resolved.enabled || resolved.endpoint === null || !signalEnabled) {
        set.status = 503;
        return { error: 'observability disabled for this signal' };
      }

      const upstreamUrl = `${resolved.endpoint}/v1/${signal}`;
      const fwdHeaders: Record<string, string> = {
        'content-type': headers['content-type'] ?? 'application/json',
      };
      // Forward the client's content-encoding (e.g. gzip) so we don't have to
      // decode/re-encode — the body bytes pass through untouched.
      if (headers['content-encoding']) {
        fwdHeaders['content-encoding'] = headers['content-encoding'];
      }
      if (resolved.ingestion_key) {
        fwdHeaders['signoz-access-token'] = resolved.ingestion_key;
      }

      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
      try {
        const res = await fetch(upstreamUrl, {
          method: 'POST',
          headers: fwdHeaders,
          // Forward EXACTLY the incoming bytes. Don't pass `bytes.buffer` — for a
          // Uint8Array view (subarray) that ignores byteOffset/byteLength and
          // would forward the whole backing buffer, corrupting the OTLP payload.
          // `slice()` copies just the view's bytes into a standalone ArrayBuffer.
          body: bytes.slice().buffer as ArrayBuffer,
        });
        // Mirror the upstream status + body so the client's exporter sees a real
        // OTLP response (it inspects the status to decide retry/drop).
        set.status = res.status;
        const respType = res.headers.get('content-type');
        if (respType) set.headers['content-type'] = respType;
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ signal, err: msg }, 'OTLP proxy forward failed');
        // 502: upstream unreachable. The client exporter treats 5xx as
        // retryable and will resend on the next batch.
        set.status = 502;
        return { error: `upstream forward failed: ${msg}` };
      }
    },
    { parse: 'arrayBuffer' },
  );
