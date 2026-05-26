/**
 * /api/enrichment/* — operator-facing routes for the slow-tier enrichment
 * workers. Today only the geocode worker has settings (Nominatim URL +
 * enabled flag); the face/describe workers will slot into this surface
 * when they ship.
 *
 *   GET  /api/enrichment/config        — current effective config + sources
 *   PUT  /api/enrichment/config        — save new config; runs health-check
 *   POST /api/enrichment/test          — health-check an arbitrary Nominatim
 *                                        URL without saving (UI "Test" button)
 *   POST /api/enrichment/test-meili    — health-check an arbitrary
 *                                        Meilisearch URL without saving
 *   POST /api/enrichment/test-describe — health-check a describe provider
 *
 * All routes are mounted behind `requireAuth` — see `src/index.ts`.
 */

import { Elysia, t } from 'elysia';
import { child as childLogger } from '../log.ts';
import {
  MAX_DESCRIBE_DAILY_CAP_USD,
  MAX_NOMINATIM_RATE_LIMIT_PER_SEC,
  MIN_DESCRIBE_DAILY_CAP_USD,
  MIN_NOMINATIM_RATE_LIMIT_PER_SEC,
  asDescribeProvider,
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  saveEnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';
import { applyEnrichmentConfig } from '../enrichment/bootstrap.ts';
import { applyDescribeConfig } from '../enrichment/describe-bootstrap.ts';
import { NominatimClient, NominatimError } from '../enrichment/nominatim-client.ts';
import { getFaceModelsStatus, probeFaceModelFiles } from '../enrichment/face-models.ts';
import { RemoteError, getDescribeProvider } from '../enrichment/describe-providers/index.ts';
import {
  createMeilisearchClient,
  reconfigureMeilisearch,
} from '../enrichment/meilisearch-client.ts';

const log = childLogger('enrichment:routes');

const ConfigBody = t.Object({
  nominatim_url: t.Union([t.String(), t.Null()]),
  geocode_worker_enabled: t.Boolean(),
  /** Optional in PUT — when omitted, the existing DB value (or env, or
   * default) is kept. Send a number to set, or `null` to clear back to
   * env-or-default. */
  nominatim_rate_limit_per_sec: t.Optional(t.Union([t.Number(), t.Null()])),
  // ── Describe worker (Phase 6) ──────────────────────────────────────
  describe_worker_enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  describe_provider: t.Optional(t.Union([t.String(), t.Null()])),
  describe_model: t.Optional(t.Union([t.String(), t.Null()])),
  describe_system_prompt: t.Optional(t.Union([t.String(), t.Null()])),
  describe_daily_cap_usd: t.Optional(t.Union([t.Number(), t.Null()])),
  describe_provider_url: t.Optional(t.Union([t.String(), t.Null()])),
  // ── Face worker (Phase 5) ──────────────────────────────────────────
  face_worker_enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  /** Operator-tunable face worker model paths. `null` clears the override
   * back to env / default; omitted leaves the saved value alone. */
  face_model_dir: t.Optional(t.Union([t.String(), t.Null()])),
  face_detector_url: t.Optional(t.Union([t.String(), t.Null()])),
  face_detector_sha256: t.Optional(t.Union([t.String(), t.Null()])),
  face_recognizer_url: t.Optional(t.Union([t.String(), t.Null()])),
  face_recognizer_sha256: t.Optional(t.Union([t.String(), t.Null()])),
  // Legacy field names kept on the body schema so operator UIs that still
  // post them don't get a 400. The route forwards them to
  // saveEnrichmentConfig, which transparently remaps each legacy key
  // onto its new equivalent (face_retinaface_* -> face_detector_*,
  // face_mobilefacenet_* -> face_recognizer_*) at write time so the
  // resolver finds the saved value under the canonical name. When a
  // patch carries both the legacy and the new key, the new key wins.
  face_retinaface_url: t.Optional(t.Union([t.String(), t.Null()])),
  face_retinaface_sha256: t.Optional(t.Union([t.String(), t.Null()])),
  face_mobilefacenet_url: t.Optional(t.Union([t.String(), t.Null()])),
  face_mobilefacenet_sha256: t.Optional(t.Union([t.String(), t.Null()])),
  // ── Search index (Phase 7) ─────────────────────────────────────────
  /** Meilisearch sidecar URL. `null`/empty clears back to the
   * `MAPLE_MEILISEARCH_URL` env var (or disables the sidecar); omitted
   * leaves the saved value alone. The API key is NOT settable here — it
   * stays the `MAPLE_MEILISEARCH_API_KEY` env var. */
  meilisearch_url: t.Optional(t.Union([t.String(), t.Null()])),
});

const TestBody = t.Object({
  nominatim_url: t.String({ minLength: 1 }),
});

const TestMeiliBody = t.Object({
  meilisearch_url: t.String({ minLength: 1 }),
});

const TestDescribeBody = t.Object({
  provider: t.String({ minLength: 1 }),
  url: t.Optional(t.Union([t.String(), t.Null()])),
  model: t.Optional(t.Union([t.String(), t.Null()])),
  api_key: t.Optional(t.Union([t.String(), t.Null()])),
});

/** Best-effort URL validator. We accept http(s) only — Nominatim and
 * Meilisearch don't speak anything else and it'd be a footgun to allow
 * `file://` etc. Returns the trimmed, trailing-slash-stripped URL, `null`
 * for empty input, or `{ error }` for an invalid value. */
function validateHttpUrl(raw: string | null): string | null | { error: string } {
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
  // Strip trailing slashes so the saved value matches what NominatimClient
  // produces internally.
  return trimmed.replace(/\/+$/, '');
}

export const enrichmentRoutes = new Elysia({ prefix: '/api/enrichment' })
  .get('/config', async () => {
    const dbConfig = await loadEnrichmentConfig();
    const resolved = resolveEnrichmentConfig(dbConfig);
    // Live face-models status — combines the loader's runtime state
    // (idle / downloading / loaded / error) with a disk probe so the
    // operator can see "files ready, will load on enable" vs. "missing,
    // will auto-download". Powers the status pill on the face card.
    const probe = probeFaceModelFiles(resolved.face_model_dir);
    const status = getFaceModelsStatus();
    return {
      ...resolved,
      face_models: {
        status: status.kind,
        error_detail: status.errorDetail,
        detector: probe.detector,
        recognizer: probe.recognizer,
        // Legacy aliases kept on the response for one release so any UI
        // that still keys off them keeps rendering. New consumers should
        // read `detector` / `recognizer`.
        retinaface: probe.detector,
        mobilefacenet: probe.recognizer,
      },
    };
  })

  .put(
    '/config',
    async ({ body, set }) => {
      const validated = validateHttpUrl(body.nominatim_url);
      if (validated && typeof validated === 'object' && 'error' in validated) {
        set.status = 400;
        return { error: `Invalid nominatim_url: ${validated.error}` };
      }
      const url = validated as string | null;

      // Range-check the rate limit. `undefined` = field omitted (keep
      // existing); `null` = clear to env-or-default; otherwise must be in
      // (MIN, MAX]. Reject 0 / negative — a misclick mustn't pause the
      // worker silently.
      let rateLimit: number | null | undefined = body.nominatim_rate_limit_per_sec;
      if (typeof rateLimit === 'number') {
        if (
          !Number.isFinite(rateLimit) ||
          rateLimit < MIN_NOMINATIM_RATE_LIMIT_PER_SEC ||
          rateLimit > MAX_NOMINATIM_RATE_LIMIT_PER_SEC
        ) {
          set.status = 400;
          return {
            error: `Invalid nominatim_rate_limit_per_sec: must be a number between ${MIN_NOMINATIM_RATE_LIMIT_PER_SEC} and ${MAX_NOMINATIM_RATE_LIMIT_PER_SEC} (got ${rateLimit})`,
          };
        }
      }

      // If the worker would be enabled with a URL, run the health check
      // BEFORE persisting. A typo in the UI shouldn't blow up the running
      // worker — we leave the previous instance alone if the new URL fails.
      if (body.geocode_worker_enabled && url) {
        try {
          const client = new NominatimClient({ baseUrl: url });
          await client.health();
        } catch (err) {
          set.status = 502;
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ url, err: msg }, 'PUT /config health check failed');
          return {
            error: `Nominatim health check failed for ${url}: ${msg}`,
          };
        }
      }

      // ── Describe-worker validation ────────────────────────────────
      // All fields are optional. `null` clears back to env/default;
      // `undefined` leaves the existing value alone. Provider must be
      // one of the known names; cap must be in (MIN, MAX].

      let describeProvider: string | null | undefined = body.describe_provider;
      if (typeof describeProvider === 'string' && asDescribeProvider(describeProvider) === null) {
        set.status = 400;
        return {
          error: `Invalid describe_provider: must be one of "ollama", "anthropic", "openai", "gemini" (got "${describeProvider}")`,
        };
      }

      const describeCap = body.describe_daily_cap_usd;
      if (typeof describeCap === 'number') {
        if (
          !Number.isFinite(describeCap) ||
          describeCap <= MIN_DESCRIBE_DAILY_CAP_USD ||
          describeCap > MAX_DESCRIBE_DAILY_CAP_USD
        ) {
          set.status = 400;
          return {
            error: `Invalid describe_daily_cap_usd: must be a number in (${MIN_DESCRIBE_DAILY_CAP_USD}, ${MAX_DESCRIBE_DAILY_CAP_USD}] (got ${describeCap})`,
          };
        }
      }

      // ── Meilisearch URL validation ────────────────────────────────
      // `undefined` = field omitted (keep existing); `null`/empty = clear
      // back to env-or-disabled. Unlike Nominatim, an unreachable Meili URL
      // is NOT a save-blocker — search degrades to the Mongo `$text` path —
      // so we only validate the URL shape here, not connectivity.
      let meiliUrl: string | null | undefined;
      if (body.meilisearch_url !== undefined) {
        const validatedMeili = validateHttpUrl(body.meilisearch_url);
        if (validatedMeili && typeof validatedMeili === 'object' && 'error' in validatedMeili) {
          set.status = 400;
          return { error: `Invalid meilisearch_url: ${validatedMeili.error}` };
        }
        meiliUrl = validatedMeili as string | null;
      }

      await saveEnrichmentConfig({
        nominatim_url: url,
        geocode_worker_enabled: body.geocode_worker_enabled,
        ...(rateLimit !== undefined ? { nominatim_rate_limit_per_sec: rateLimit } : {}),
        ...(body.describe_worker_enabled !== undefined
          ? { describe_worker_enabled: body.describe_worker_enabled }
          : {}),
        ...(describeProvider !== undefined
          ? {
              describe_provider:
                describeProvider === null ? null : asDescribeProvider(describeProvider),
            }
          : {}),
        ...(body.describe_model !== undefined ? { describe_model: body.describe_model } : {}),
        ...(body.describe_system_prompt !== undefined
          ? { describe_system_prompt: body.describe_system_prompt }
          : {}),
        ...(describeCap !== undefined ? { describe_daily_cap_usd: describeCap } : {}),
        ...(body.describe_provider_url !== undefined
          ? { describe_provider_url: body.describe_provider_url }
          : {}),
        ...(body.face_model_dir !== undefined ? { face_model_dir: body.face_model_dir } : {}),
        ...(body.face_detector_url !== undefined
          ? { face_detector_url: body.face_detector_url }
          : {}),
        ...(body.face_detector_sha256 !== undefined
          ? { face_detector_sha256: body.face_detector_sha256 }
          : {}),
        ...(body.face_recognizer_url !== undefined
          ? { face_recognizer_url: body.face_recognizer_url }
          : {}),
        ...(body.face_recognizer_sha256 !== undefined
          ? { face_recognizer_sha256: body.face_recognizer_sha256 }
          : {}),
        ...(body.face_retinaface_url !== undefined
          ? { face_retinaface_url: body.face_retinaface_url }
          : {}),
        ...(body.face_retinaface_sha256 !== undefined
          ? { face_retinaface_sha256: body.face_retinaface_sha256 }
          : {}),
        ...(body.face_mobilefacenet_url !== undefined
          ? { face_mobilefacenet_url: body.face_mobilefacenet_url }
          : {}),
        ...(body.face_mobilefacenet_sha256 !== undefined
          ? { face_mobilefacenet_sha256: body.face_mobilefacenet_sha256 }
          : {}),
        ...(body.face_worker_enabled !== undefined
          ? { face_worker_enabled: body.face_worker_enabled }
          : {}),
        ...(meiliUrl !== undefined ? { meilisearch_url: meiliUrl } : {}),
      });

      // Re-resolve from DB to compute the effective config (in case env vars
      // contributed to fields we didn't change), then apply live.
      const dbConfig = await loadEnrichmentConfig();
      const resolved = resolveEnrichmentConfig(dbConfig);
      try {
        await applyEnrichmentConfig(resolved);
      } catch (err) {
        // We already health-checked above, so this shouldn't fire — but if
        // applyEnrichmentConfig fails (e.g. transient network blip between
        // the test call and the apply), surface it. The DB row is already
        // saved; the worker will retry the apply on next boot.
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'applyEnrichmentConfig failed after save');
        set.status = 502;
        return { error: `Saved, but worker reconfigure failed: ${msg}` };
      }
      try {
        await applyDescribeConfig(resolved);
      } catch (err) {
        // Like the geocode-side reapply, this shouldn't fail in the
        // normal path — describe-bootstrap log-and-skips on health-check
        // failure. We still surface unexpected exceptions so the
        // operator sees them.
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'applyDescribeConfig failed after save');
      }

      // Rebuild the Meilisearch client against the resolved URL so the
      // running process (search route + meili stage) picks it up without a
      // restart. Best-effort: a bad/unreachable URL just means search falls
      // back to Mongo `$text`, so we never fail the save here. When a URL is
      // present we (re)create the index in the background so a freshly
      // pointed-at Meili gets the right schema.
      reconfigureMeilisearch(resolved.meilisearch_url);
      if (resolved.meilisearch_url) {
        const meili = createMeilisearchClient({ url: resolved.meilisearch_url });
        try {
          if (await meili.health()) await meili.ensureIndex();
        } catch (err) {
          log.warn({ err }, 'Meilisearch reconfigure health/ensureIndex failed (non-fatal)');
        }
      }

      return resolved;
    },
    { body: ConfigBody },
  )

  .post(
    '/test',
    async ({ body, set }) => {
      const validated = validateHttpUrl(body.nominatim_url);
      if (validated === null) {
        set.status = 400;
        return { ok: false, error: 'URL is empty' };
      }
      if (typeof validated === 'object' && 'error' in validated) {
        set.status = 400;
        return { ok: false, error: validated.error };
      }
      try {
        const client = new NominatimClient({ baseUrl: validated });
        await client.health();
        return { ok: true, url: validated };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof NominatimError ? (err.status ?? null) : null;
        return { ok: false, error: msg, status };
      }
    },
    { body: TestBody },
  )

  // POST /api/enrichment/test-meili — health-check an arbitrary Meilisearch
  // URL without saving. The API key comes from MAPLE_MEILISEARCH_API_KEY
  // (read by createMeilisearchClient), so the probe authenticates the same
  // way the live client will.
  .post(
    '/test-meili',
    async ({ body, set }) => {
      const validated = validateHttpUrl(body.meilisearch_url);
      if (validated === null) {
        set.status = 400;
        return { ok: false, error: 'URL is empty' };
      }
      if (typeof validated === 'object' && 'error' in validated) {
        set.status = 400;
        return { ok: false, error: validated.error };
      }
      const client = createMeilisearchClient({ url: validated });
      const ok = await client.health();
      return ok
        ? { ok: true, url: validated }
        : { ok: false, error: 'Meilisearch health check failed', url: validated };
    },
    { body: TestMeiliBody },
  )

  // POST /api/enrichment/test-describe — health-check the configured
  // describe provider without persisting. Mirrors `/test` for Nominatim.
  // The `api_key` field is write-only (we never echo it back), so the UI
  // can pass a freshly-typed key without saving it.
  .post(
    '/test-describe',
    async ({ body, set }) => {
      const provider = asDescribeProvider(body.provider);
      if (!provider) {
        set.status = 400;
        return {
          ok: false,
          error: `Invalid provider "${body.provider}". Must be one of "ollama", "anthropic", "openai", "gemini".`,
        };
      }
      try {
        const client = getDescribeProvider(provider, {
          url: body.url ?? null,
          apiKey: body.api_key ?? null,
        });
        await client.health();
        return {
          ok: true,
          info: {
            provider,
            model: body.model ?? null,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof RemoteError && err.status !== undefined ? err.status : null;
        return { ok: false, error: msg, status };
      }
    },
    { body: TestDescribeBody },
  );
