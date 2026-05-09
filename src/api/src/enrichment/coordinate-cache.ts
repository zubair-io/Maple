/**
 * Quantised lat/lon → Place cache backed by the `geocode_cache` collection.
 *
 * Why: clustered photos at one location (a museum, a restaurant, a single
 * trail head) all reverse-geocode to the same address. Quantising to 4
 * decimals (~11 m) maps "same building" to "same key", turning 100 API calls
 * into 1.
 *
 * Entries are immortal — Nominatim addresses don't drift week-to-week. Stale
 * invalidation is via `geocoderVersion`: bump the worker's handler version
 * and stale cache entries are ignored on read (and may be cleaned up by an
 * out-of-band sweep, not in scope here).
 *
 * Spec: `docs/indexer-enrichment.md` §4.3.
 */

import type { Collection } from "mongodb";
import { geocodeCacheCollection } from "../db/client.ts";
import type { GeocodeCacheDoc, Place } from "../db/schema.ts";

/** Decimal places to round lat/lon to before keying the cache.
 *  4 ≈ 11 m precision — same building usually shares a key. */
export const DEFAULT_QUANTIZATION_DECIMALS = 4;

/** Round to `decimals` places. We can't trust `Number.toFixed(d)` to round
 * uniformly across negative coordinates: `(-73.7562).toFixed(4)` is
 * `"-73.7562"`, fine, but `(-73.75625).toFixed(4)` rounds to `"-73.7562"`
 * (banker's rounding) on some hosts. Round explicitly via `Math.round`. */
export function quantize(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/** `lat:42.6526,lon:-73.7562` — see §4.3 of the design doc. */
export function quantizedKey(
  lat: number,
  lon: number,
  decimals: number = DEFAULT_QUANTIZATION_DECIMALS,
): string {
  return `lat:${quantize(lat, decimals)},lon:${quantize(lon, decimals)}`;
}

export interface CoordinateCacheConfig {
  /** Current handler version. Cache entries with a different version are
   * treated as misses and overwritten on next set(). */
  geocoderVersion: number;
  /** Lat/lon rounding precision. Default 4 decimals (~11 m). */
  decimals?: number;
  /** Time source — override in tests. */
  now?: () => Date;
}

export class CoordinateCache {
  private readonly geocoderVersion: number;
  private readonly decimals: number;
  private readonly now: () => Date;

  constructor(config: CoordinateCacheConfig) {
    this.geocoderVersion = config.geocoderVersion;
    this.decimals = config.decimals ?? DEFAULT_QUANTIZATION_DECIMALS;
    this.now = config.now ?? (() => new Date());
  }

  /** The quantised cache key for a coordinate. Useful for tests + telemetry. */
  keyFor(lat: number, lon: number): string {
    return quantizedKey(lat, lon, this.decimals);
  }

  /** Cache hit only if the entry's `geocoder_version` matches the worker's
   * current handler version. Mismatches are treated as misses so a parser
   * upgrade re-fetches automatically. */
  async get(lat: number, lon: number): Promise<Place | null> {
    const c = await this.coll();
    const doc = await c.findOne({ _id: this.keyFor(lat, lon) });
    if (!doc) return null;
    if (doc.geocoder_version !== this.geocoderVersion) return null;
    return doc.place;
  }

  /** Upsert. Idempotent — a worker that re-runs `process()` after a partial
   * crash overwrites the entry cleanly. */
  async set(lat: number, lon: number, place: Place): Promise<void> {
    const c = await this.coll();
    await c.updateOne(
      { _id: this.keyFor(lat, lon) },
      {
        $set: {
          place,
          fetched_at: this.now(),
          geocoder_version: this.geocoderVersion,
        },
      },
      { upsert: true },
    );
  }

  private coll(): Promise<Collection<GeocodeCacheDoc>> {
    return geocodeCacheCollection();
  }
}
