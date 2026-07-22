/**
 * Location resolution for the backup-ingest hot path.
 *
 * backup-ingest builds a destination folder from capture date + location
 * segments (`<year>/<State|Country>/<Town/City||Place>/<file>` vs the date-only
 * `<year>/<MM>/<file>`). The location comes from `geocode_cache`, which is
 * normally filled asynchronously by the enrichment geocode worker — so on a
 * cold cache (a fresh bulk import) every path falls back to the date-only
 * layout, and a late geocode never relocates files already written. This
 * resolves the location LIVE on a cache miss so the geo segments land at write
 * time. (The `refile-backups` cleanup later relocates any file that was written
 * before its place was known.)
 *
 * Invariants:
 *   - Soft failure only. Nominatim not configured / disabled / unreachable /
 *     slow / a parse error all fall back to `null` (date-only path). A geocode
 *     hiccup must never fail or stall an upload — the worker will fill the gap
 *     later, and the next photo at the same place reuses whatever lands.
 *   - Reads + writes the SAME `geocode_cache` (and version) the worker uses,
 *     so clustered photos (quantised to one key) geocode once and the rest hit
 *     warm, and the async worker won't redo the work.
 *   - Concurrent ingests for the same not-yet-cached location share one
 *     in-flight lookup (in-process dedup) instead of stampeding Nominatim.
 */
import { CoordinateCache, quantizedKey } from '../enrichment/coordinate-cache.ts';
import { NominatimClient } from '../enrichment/nominatim-client.ts';
import { parseNominatimResponse } from '../enrichment/place-parser.ts';
import { backupLocationSegments } from './location-segments.ts';
import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
// Share the worker's handler version so ingest-written cache rows interoperate
// with the async geocode worker's (same key, same version → no re-fetch).
import { GEOCODE_HANDLER_VERSION } from '../workers/stages/geocode.ts';
import { child as childLogger } from '../log.ts';
import type { Place } from '../db/schema.ts';

const log = childLogger('backup-ingest-geocode');

// The cache needs no Nominatim config, so it's always available for warm
// reads. The client is built lazily and only when Nominatim is configured.
let _cache: CoordinateCache | null = null;
let _client: NominatimClient | null = null;
/** Set once we've resolved config and found no usable Nominatim, so we don't
 * re-hit Mongo for the config doc on every cache miss. Cleared by the test
 * setter. */
let _clientUnconfigured = false;

/** In-process dedup of concurrent live lookups, keyed by quantised coordinate.
 * A burst of photos at one new location resolves to a single Nominatim call. */
const inflight = new Map<string, Promise<Place | null>>();

function getCache(): CoordinateCache {
  if (!_cache) _cache = new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION });
  return _cache;
}

/** Build (and memoise) the Nominatim client from the resolved enrichment
 * config. Returns null when no URL is configured or geocoding is disabled —
 * the caller then serves warm-cache hits only and otherwise falls back to the
 * date-only path. */
async function getClient(): Promise<NominatimClient | null> {
  if (_client) return _client;
  if (_clientUnconfigured) return null;
  try {
    const cfg = resolveEnrichmentConfig(await loadEnrichmentConfig());
    if (!cfg.nominatim_url || !cfg.geocode_worker_enabled) {
      _clientUnconfigured = true;
      return null;
    }
    _client = new NominatimClient({
      baseUrl: cfg.nominatim_url,
      rateLimitPerSec: cfg.nominatim_rate_limit_per_sec,
    });
    return _client;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'could not resolve geocode config — date-only paths');
    _clientUnconfigured = true;
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function liveGeocode(
  client: NominatimClient,
  cache: CoordinateCache,
  lat: number,
  lon: number,
): Promise<Place | null> {
  try {
    const raw = await client.reverse(lat, lon);
    const place = parseNominatimResponse(raw, lat, lon, GEOCODE_HANDLER_VERSION, () => new Date());
    // Cache even an unresolvable result (empty pois/rollups) — the worker does
    // the same, and it stops every sibling photo from re-querying a location
    // Nominatim has no name for.
    await cache.set(lat, lon, place);
    return place;
  } catch (err) {
    log.warn(
      { err: errMsg(err), lat, lon },
      'live geocode failed — falling back to date-only path',
    );
    return null;
  }
}

/**
 * Resolve the ordered location segments for `(lat, lon)`: warm-cache hit first,
 * then a live Nominatim lookup (deduped + cached) when configured. Returns
 * `[]` — meaning "use the date-only path" — for non-finite input, a cold cache
 * with no geocoder, any geocode failure, or an unresolvable location. The
 * shape of a non-empty result is `[<State|Country>, <Town/City||Place>]` (see
 * `backupLocationSegments`).
 */
export async function resolveBackupLocation(lat: number, lon: number): Promise<string[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const cache = getCache();
  const cached = await cache.get(lat, lon);
  if (cached) return backupLocationSegments(cached);

  const client = await getClient();
  if (!client) return []; // no live geocoder → date-only (prior behaviour)

  const key = quantizedKey(lat, lon);
  let p = inflight.get(key);
  if (!p) {
    p = liveGeocode(client, cache, lat, lon).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
  }
  return backupLocationSegments(await p);
}

/** Test seam. Inject a client + cache, or pass `null` to reset to the
 * lazily-built, config-driven defaults. An explicitly-null `client` means
 * "no live geocoder" — `getClient()` then short-circuits instead of falling
 * through to a real config/Mongo load. */
export function setIngestGeocodeDepsForTests(
  deps: {
    client: NominatimClient | null;
    cache: CoordinateCache | null;
  } | null,
): void {
  inflight.clear();
  if (deps === null) {
    _client = null;
    _cache = null;
    _clientUnconfigured = false;
    return;
  }
  _client = deps.client;
  _cache = deps.cache;
  _clientUnconfigured = deps.client === null;
}
