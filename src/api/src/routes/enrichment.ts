/**
 * /api/enrichment/* — operator-facing routes for the slow-tier enrichment
 * workers. Today only the geocode worker has settings (Nominatim URL +
 * enabled flag); the face/describe workers will slot into this surface
 * when they ship.
 *
 *   GET  /api/enrichment/config        — current effective config + sources
 *   PUT  /api/enrichment/config        — save new config; runs health-check
 *   POST /api/enrichment/test          — health-check an arbitrary URL
 *                                        without saving (UI "Test" button)
 *
 * All routes are mounted behind `requireAuth` — see `src/index.ts`.
 */

import { Elysia, t } from "elysia";
import { child as childLogger } from "../log.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  saveEnrichmentConfig,
} from "../enrichment/enrichment-config.repo.ts";
import {
  applyEnrichmentConfig,
} from "../enrichment/bootstrap.ts";
import { NominatimClient, NominatimError } from "../enrichment/nominatim-client.ts";

const log = childLogger("enrichment:routes");

const ConfigBody = t.Object({
  nominatim_url: t.Union([t.String(), t.Null()]),
  geocode_worker_enabled: t.Boolean(),
});

const TestBody = t.Object({
  nominatim_url: t.String({ minLength: 1 }),
});

/** Best-effort URL validator. We accept http(s) only — Nominatim doesn't
 * speak anything else and it'd be a footgun to allow `file://` etc. */
function validateNominatimUrl(raw: string | null): string | null | { error: string } {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "Not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `Unsupported protocol: ${parsed.protocol}` };
  }
  // Strip trailing slashes so the saved value matches what NominatimClient
  // produces internally.
  return trimmed.replace(/\/+$/, "");
}

export const enrichmentRoutes = new Elysia({ prefix: "/api/enrichment" })
  .get("/config", async () => {
    const dbConfig = await loadEnrichmentConfig();
    const resolved = resolveEnrichmentConfig(dbConfig);
    return resolved;
  })

  .put(
    "/config",
    async ({ body, set }) => {
      const validated = validateNominatimUrl(body.nominatim_url);
      if (validated && typeof validated === "object" && "error" in validated) {
        set.status = 400;
        return { error: `Invalid nominatim_url: ${validated.error}` };
      }
      const url = validated as string | null;

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
          log.warn({ url, err: msg }, "PUT /config health check failed");
          return {
            error: `Nominatim health check failed for ${url}: ${msg}`,
          };
        }
      }

      await saveEnrichmentConfig({
        nominatim_url: url,
        geocode_worker_enabled: body.geocode_worker_enabled,
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
        log.error({ err: msg }, "applyEnrichmentConfig failed after save");
        set.status = 502;
        return { error: `Saved, but worker reconfigure failed: ${msg}` };
      }
      return resolved;
    },
    { body: ConfigBody },
  )

  .post(
    "/test",
    async ({ body, set }) => {
      const validated = validateNominatimUrl(body.nominatim_url);
      if (validated === null) {
        set.status = 400;
        return { ok: false, error: "URL is empty" };
      }
      if (typeof validated === "object" && "error" in validated) {
        set.status = 400;
        return { ok: false, error: validated.error };
      }
      try {
        const client = new NominatimClient({ baseUrl: validated });
        await client.health();
        return { ok: true, url: validated };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof NominatimError ? err.status ?? null : null;
        return { ok: false, error: msg, status };
      }
    },
    { body: TestBody },
  );
