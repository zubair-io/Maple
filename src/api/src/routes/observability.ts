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
 * All routes are mounted behind `requireAuth` — see `src/index.ts`. The
 * ingestion key is echoed on GET (unlike the meilisearch key, which is
 * write-only) BECAUSE the client transport posts straight to SigNoz with it;
 * the gate is the bearer-auth wrapper, not field-level redaction. Write
 * semantics still mirror meilisearch_api_key (non-empty sets, null clears to
 * env, ""/omitted leaves unchanged) so a blank field in the UI never wipes a
 * key the operator typed once.
 */

import { Elysia, t } from 'elysia';
import { child as childLogger } from '../log.ts';
import {
  MAX_SAMPLE_RATIO,
  MIN_SAMPLE_RATIO,
  loadObservabilityConfig,
  resolveObservabilityConfig,
  saveObservabilityConfig,
  validateHttpUrl,
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

const TestBody = t.Object({
  endpoint: t.String({ minLength: 1 }),
  /** Optional write-only key to probe with a not-yet-saved value. When omitted
   * the request is unauthenticated (a keyless SigNoz still accepts it). */
  ingestion_key: t.Optional(t.Union([t.String(), t.Null()])),
});

export const observabilityRoutes = new Elysia({ prefix: '/api/observability' })
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
      // ── endpoint ──────────────────────────────────────────────────────
      // `undefined` = field omitted (keep existing); `null`/empty = clear back
      // to env/unset; otherwise must be a valid http(s) URL (trailing slashes
      // stripped on save so `${endpoint}/v1/traces` doesn't double up).
      let endpoint: string | null | undefined;
      if (body.endpoint !== undefined) {
        const validated = validateHttpUrl(body.endpoint);
        if (validated && typeof validated === 'object' && 'error' in validated) {
          set.status = 400;
          return { error: `Invalid endpoint: ${validated.error}` };
        }
        endpoint = validated as string | null;
      }

      // ── sample_ratio ──────────────────────────────────────────────────
      // `undefined` = keep existing; `null` = clear to env/default; otherwise
      // must be a finite number in [0, 1].
      const sampleRatio = body.sample_ratio;
      if (typeof sampleRatio === 'number') {
        if (
          !Number.isFinite(sampleRatio) ||
          sampleRatio < MIN_SAMPLE_RATIO ||
          sampleRatio > MAX_SAMPLE_RATIO
        ) {
          set.status = 400;
          return {
            error: `Invalid sample_ratio: must be a number between ${MIN_SAMPLE_RATIO} and ${MAX_SAMPLE_RATIO} (got ${sampleRatio})`,
          };
        }
      }

      // ── ingestion_key (secret, write-only on input) ───────────────────
      // `undefined`/empty string = leave the saved key unchanged (a blank
      // field in the UI must not wipe it); `null` = clear back to env; a
      // non-empty string sets a new key.
      let ingestionKey: string | null | undefined;
      if (body.ingestion_key === null) {
        ingestionKey = null;
      } else if (typeof body.ingestion_key === 'string') {
        const trimmed = body.ingestion_key.trim();
        if (trimmed.length > 0) ingestionKey = trimmed;
      }

      await saveObservabilityConfig({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(ingestionKey !== undefined ? { ingestion_key: ingestionKey } : {}),
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
    { body: ConfigBody },
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
      // semantics: a typed key wins; otherwise fall back to the saved DB key so
      // testing a saved-key deployment with a blank field still authenticates.
      // The field is write-only, so the UI can't echo the key back to send it.
      let probeKey: string | null = null;
      if (typeof body.ingestion_key === 'string' && body.ingestion_key.trim().length > 0) {
        probeKey = body.ingestion_key.trim();
      } else {
        const saved = await loadObservabilityConfig();
        if (typeof saved?.ingestion_key === 'string' && saved.ingestion_key.trim().length > 0) {
          probeKey = saved.ingestion_key.trim();
        }
      }
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
        const contentType = res.headers.get('content-type');

        if (!res.ok) {
          // Non-2xx. A 404 most often means "right host, wrong port" — the
          // endpoint answered HTTP but has no /v1/traces route. Append the port
          // hint when we have one (applies to any non-2xx, 404 included).
          const base = `SigNoz returned HTTP ${res.status}`;
          const error = portHint ? `${base}. ${portHint}` : base;
          return { ok: false, status: res.status, error, recommendation: portHint ?? undefined };
        }

        // 2xx — but a 2xx from the UI/query port (an HTML SPA page) is NOT a
        // real OTLP accept. Only treat it as success when the response actually
        // looks like OTLP (JSON / protobuf). Otherwise flag it + recommend 4318.
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
    { body: TestBody },
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
