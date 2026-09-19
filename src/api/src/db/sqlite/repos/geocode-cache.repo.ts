/**
 * `geocode_cache` — the SQLite port of the quantised lat/lon → Place cache
 * (#3751).
 *
 * ## What this replaces
 *
 * The storage half of `enrichment/coordinate-cache.ts`: the `findOne` in
 * `CoordinateCache.get` and the upsert in `CoordinateCache.set`, plus the one
 * keyed read `routes/geocode-reverse.ts` performs directly on the collection.
 *
 * The quantisation itself stays where it is. `quantizedKey` is arithmetic on
 * two numbers with no database in it, so at the cutover (#3752) the cache class
 * keeps computing its own key and calls {@link getCachedPlace} /
 * {@link setCachedPlace} with the result.
 *
 * ## Two reads, because the callers genuinely want different things
 *
 * The worker treats a version mismatch as a miss, so a parser upgrade
 * re-fetches rather than serving a Place the current code would have parsed
 * differently — that is {@link getCachedPlace}. The device-facing route
 * deliberately does not check the version, because a stale address is still
 * good enough to pick a destination folder and the indexer owns refreshing it —
 * that is {@link findCachedPlace}. Collapsing them into one function with a
 * flag would hide a difference both call sites argue for in their own comments.
 *
 * ## What `fetched_at` is for
 *
 * Provenance. Nothing in the repository reads the column, and expiry is by
 * version rather than by age — Nominatim addresses do not drift week to week.
 *
 * The instant comes from the caller rather than from a clock call here, because
 * `CoordinateCache` already owns an injectable `now` that one of its tests pins.
 * Stamping it in this module would leave that clock with no consumer at the
 * cutover and quietly turn a deterministic test into one that accepts whatever
 * the wall clock said. The parameter defaults to now, so a caller with no
 * opinion still gets the obvious behaviour.
 */

import type { Place } from '../../schema.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, parseJson } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

const SELECT_SQL = `SELECT place, geocoder_version FROM geocode_cache WHERE id = ?`;

const UPSERT_SQL = `
  INSERT INTO geocode_cache (id, place, fetched_at, geocoder_version) VALUES (?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    place = excluded.place,
    fetched_at = excluded.fetched_at,
    geocoder_version = excluded.geocoder_version`;

interface CacheRow {
  place: string;
  geocoder_version: number;
}

/**
 * The cached Place for a quantised key, or `null` for a miss.
 *
 * An entry written by a different geocoder version reads as a miss, which is
 * what makes a parser upgrade self-healing: the worker re-fetches and
 * {@link setCachedPlace} overwrites the stale row in place.
 */
export async function getCachedPlace(
  key: string,
  geocoderVersion: number,
  dbOverride?: SqliteDb,
): Promise<Place | null> {
  const row = (await sqliteDb(dbOverride).read<CacheRow>(SELECT_SQL, [key]))[0];
  if (row === undefined || row.geocoder_version !== geocoderVersion) return null;
  return parseJson<Place | null>(row.place, null);
}

/**
 * The cached Place for a quantised key whatever version wrote it.
 *
 * `GET /api/geocode/reverse` answers a backing-up device that needs a folder
 * name before it uploads bytes; a stale address still names the right place,
 * and refreshing it is the indexer's job rather than this request's.
 */
export async function findCachedPlace(key: string, dbOverride?: SqliteDb): Promise<Place | null> {
  const row = (await sqliteDb(dbOverride).read<CacheRow>(SELECT_SQL, [key]))[0];
  if (row === undefined) return null;
  return parseJson<Place | null>(row.place, null);
}

/**
 * Store (or overwrite) the Place for a quantised key.
 *
 * Idempotent, exactly as the Mongo upsert was: a worker that re-runs after a
 * partial crash replaces the entry cleanly rather than duplicating it.
 *
 * `fetchedAt` is a parameter rather than a call to the clock because
 * `CoordinateCache` already owns an injectable `now` and a test pins it. The
 * column is diagnostic — nothing in production reads it — but taking the
 * instant keeps that test meaningful across the cutover instead of asking it
 * to accept whatever the wall clock said.
 */
export async function setCachedPlace(
  key: string,
  place: Place,
  geocoderVersion: number,
  fetchedAt: string = nowIso(),
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(UPSERT_SQL, [
    key,
    JSON.stringify(place),
    fetchedAt,
    geocoderVersion,
  ]);
}
