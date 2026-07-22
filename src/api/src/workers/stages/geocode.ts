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

import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { CoordinateCache } from '../../enrichment/coordinate-cache.ts';
import { NominatimClient } from '../../enrichment/nominatim-client.ts';
import { parseNominatimResponse } from '../../enrichment/place-parser.ts';
import { loadEnrichmentConfig } from '../../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../../enrichment/enrichment-config.resolve.ts';
import { backupLocationSegments } from '../../backup/location-segments.ts';
import type { Place } from '../../db/schema.ts';

export const GEOCODE_HANDLER_VERSION = 1;

/** The canonical backup folder is derived from a place's location segments
 * (`<Country|State>/<City>`). Reset value for `backup_layout_version` that puts
 * an asset back into the refile-backups candidate set. */
const REFILE_RESET_VERSION = 0;

/** True when geocoding produced a place whose backup folder differs from where
 * the asset is currently filed — i.e. the file should be re-located. Comparing
 * the derived segments (not the whole place) means a cosmetic place change that
 * doesn't move the folder won't trigger a needless re-file. */
function backupFolderChanged(oldPlace: Place | null | undefined, newPlace: Place): boolean {
  return (
    backupLocationSegments(oldPlace ?? null).join('/') !==
    backupLocationSegments(newPlace).join('/')
  );
}

interface GeocodeDeps {
  client: NominatimClient;
  cache: CoordinateCache;
}

let _deps: GeocodeDeps | null = null;

async function getDeps(): Promise<GeocodeDeps> {
  if (_deps) return _deps;
  const dbConfig = await loadEnrichmentConfig();
  const cfg = resolveEnrichmentConfig(dbConfig);
  if (!cfg.nominatim_url) throw new Error('geocode: nominatim URL not configured');
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

export async function geocodeHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const { client, cache } = await getDeps();
  const gps = image.exif?.gps;
  if (!gps || typeof gps.lat !== 'number' || typeof gps.lng !== 'number') {
    return { skip: 'no-gps' };
  }
  const { lat, lng } = gps;
  const cached = await cache.get(lat, lng);
  const place = cached ?? null;
  if (place) return { patch: placePatch(image, place) };

  const raw = await client.reverse(lat, lng);
  const fresh = parseNominatimResponse(raw, lat, lng, GEOCODE_HANDLER_VERSION, () => new Date());
  await cache.set(lat, lng, fresh);
  return { patch: placePatch(image, fresh) };
}

/** Write the place, and — when it changes the canonical backup folder — reset
 * `backup_layout_version` so the refile-backups migration re-files the asset to
 * the resolved location. This decouples "place resolved" from "file moved":
 * whether the place arrives at ingest, via this stage, or via a backfill, the
 * asset lands in the right folder once it's enabled. Previously a place that
 * resolved AFTER the file was first placed left it frozen in the wrong folder. */
function placePatch(image: ImageDoc, place: Place): Record<string, unknown> {
  const patch: Record<string, unknown> = { place };
  if (backupFolderChanged(image.place, place)) {
    patch.backup_layout_version = REFILE_RESET_VERSION;
  }
  return patch;
}

const geocodeStage = defineStage({
  name: 'geocode',
  // v2: exif v2 corrects western-hemisphere longitude sign — bump so docs
  // already geocoded with the wrong-sign coords re-run against the fixed gps.
  targetVersion: 2,
  // Wait for exif v2 specifically — dep on bare "exif" would let geocode
  // run on stale v1 coords if it polls a doc before exif catches up.
  dependsOn: [{ name: 'exif', minVersion: 2 }],
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: geocodeHandler,
});

export default geocodeStage;

export async function startGeocodeStage(): Promise<RunStageHandle> {
  return runStage(geocodeStage);
}
