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
} from '../observability/observability-config.repo.ts';
import { applyOtelConfig } from '../otel.ts';

const log = childLogger('observability:routes');

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
    const dbConfig = await loadObservabilityConfig();
    // The ingestion key IS returned here — direct-to-SigNoz clients need it.
    // Access is gated by the requireAuth wrapper this route mounts behind.
    return resolveObservabilityConfig(dbConfig);
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

      return resolved;
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
      try {
        const res = await fetch(`${validated}/v1/traces`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ resourceSpans: [] }),
        });
        return res.ok
          ? { ok: true, status: res.status }
          : { ok: false, status: res.status, error: `SigNoz returned HTTP ${res.status}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
    { body: TestBody },
  );
