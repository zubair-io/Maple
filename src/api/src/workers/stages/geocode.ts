/**
 * Geocode stage. Wraps `nominatim-client.ts` + `coordinate-cache.ts` +
 * `place-parser.ts`.
 *
 * `pausedOnFirstBoot: true` — Nominatim is rate-limited (default 1 req/s for
 * public, operator-configured for self-hosted). The operator must confirm their
 * Nominatim URL and rate limit in `/settings/workers` before unpausing.
 *
 * Images without GPS coordinates return `{ skip }` — not an error, not
 * retried. The runtime counts them as successes toward throughput and marks
 * the stage done so the meili fan-in is unblocked.
 *
 * The old worker's inline Meilisearch upsert is dropped — the `meili` stage
 * (Task 5) owns the Meilisearch write once all enrichment stages have run.
 */

import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { CoordinateCache } from "../../enrichment/coordinate-cache.ts";
import { NominatimClient } from "../../enrichment/nominatim-client.ts";
import { parseNominatimResponse } from "../../enrichment/place-parser.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
} from "../../enrichment/enrichment-config.repo.ts";

export const GEOCODE_HANDLER_VERSION = 1;

interface GeocodeDeps {
  client: NominatimClient;
  cache: CoordinateCache;
}

let _deps: GeocodeDeps | null = null;

async function getDeps(): Promise<GeocodeDeps> {
  if (_deps) return _deps;
  const dbConfig = await loadEnrichmentConfig();
  const cfg = resolveEnrichmentConfig(dbConfig);
  if (!cfg.nominatim_url) throw new Error("geocode: nominatim URL not configured");
  const client = new NominatimClient({
    baseUrl: cfg.nominatim_url,
    rateLimitPerSec: cfg.nominatim_rate_limit_per_sec,
  });
  const cache = new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION });
  _deps = { client, cache };
  return _deps;
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setGeocodeDepsForTests(deps: GeocodeDeps | null): void {
  _deps = deps;
}

export async function geocodeHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const { client, cache } = await getDeps();
  const gps = image.exif?.gps;
  if (!gps || typeof gps.lat !== "number" || typeof gps.lng !== "number") {
    return { skip: "no-gps" };
  }
  const { lat, lng } = gps;
  const cached = await cache.get(lat, lng);
  if (cached) {
    return { patch: { place: cached } };
  }
  const raw = await client.reverse(lat, lng);
  const place = parseNominatimResponse(raw, lat, lng, GEOCODE_HANDLER_VERSION, () => new Date());
  await cache.set(lat, lng, place);
  return { patch: { place } };
}

export default defineStage({
  name: "geocode",
  targetVersion: 1,
  dependsOn: ["exif"],
  defaults: {
    concurrency: 1,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: geocodeHandler,
});
