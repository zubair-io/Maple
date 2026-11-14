/**
 * Reads behind the service photo API: count, page, day histogram and the wire shape of a photo.
 * Every statement takes the request's {@link SearchWhere} from `service-photos.where.ts`, so the
 * owner scope and the visibility rules are applied in exactly one place.
 */

import { assetsDb, peopleDb, readBulk, type SqliteDb } from './db-handle.ts';
import { primaryLocationsSql } from './people.sql.ts';
import type { Term } from './search.terms.ts';
import { searchWhereSql, type SearchWhere } from './search.where.ts';
import { countryName } from './service-photos.place.ts';
import { assetIdsPredicate } from './service-photos.where.ts';
import { placeholders } from './values.ts';

export interface ServicePlace {
  label: string | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
}

export interface ServicePhoto {
  assetId: string;
  capturedAt: string;
  place: ServicePlace | null;
  lat: number | null;
  lng: number | null;
  people: Array<{ id: string; name: string }>;
}

export interface PhotoDay {
  date: string;
  count: number;
  place: string | null;
}

/** Newest-first position of a photo: its capture time, then its id. */
export interface PhotoSeek {
  capturedAt: string;
  assetId: string;
}

const MAX_PHOTO_DAYS = 366;

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

/** "Windham, New York"; the region or locality alone; else the country's English name. */
function placeLabel(
  locality: string | null,
  region: string | null,
  countryCode: string | null,
): string | null {
  const loc = nonEmpty(locality);
  const reg = nonEmpty(region);
  if (loc !== null && reg !== null) return `${loc}, ${reg}`;
  return loc ?? reg ?? countryName(nonEmpty(countryCode));
}

export async function countPhotos(
  where: SearchWhere,
  extra?: Term,
  db?: SqliteDb,
): Promise<number> {
  const bound = searchWhereSql(where, extra);
  const rows = await readBulk<{ n: number }>(
    assetsDb(db),
    `SELECT COUNT(*) AS n FROM assets ${bound.sql}`,
    bound.params,
  );
  return rows[0]?.n ?? 0;
}

/** Up to `limit` photo ids, newest capture first, strictly after `after` when given. */
export async function pagePhotoIds(
  where: SearchWhere,
  after: PhotoSeek | null,
  limit: number,
  db?: SqliteDb,
): Promise<PhotoSeek[]> {
  const seek: Term | undefined =
    after === null
      ? undefined
      : {
          sql: '(assets.captured_at < ? OR (assets.captured_at = ? AND assets.id < ?))',
          params: [after.capturedAt, after.capturedAt, after.assetId],
        };
  const bound = searchWhereSql(where, seek);
  const rows = await readBulk<{ id: string; captured_at: string }>(
    assetsDb(db),
    `SELECT assets.id AS id, assets.captured_at AS captured_at FROM assets ${bound.sql}
      ORDER BY assets.captured_at DESC, assets.id DESC LIMIT ?`,
    [...bound.params, limit],
  );
  return rows.map((row) => ({ capturedAt: row.captured_at, assetId: row.id }));
}

interface DayPlaceRow {
  day: string;
  locality: string | null;
  region: string | null;
  country_code: string | null;
  n: number;
}

function mostCommonLabel(labels: ReadonlyMap<string, number>): string | null {
  const ranked = [...labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

/** Photos per capture day, newest day first, each with its most common place label. */
export async function photoDays(
  where: SearchWhere,
  extra?: Term,
  db?: SqliteDb,
): Promise<PhotoDay[]> {
  const bound = searchWhereSql(where, extra);
  const rows = await readBulk<DayPlaceRow>(
    assetsDb(db),
    `SELECT substr(assets.captured_at, 1, 10) AS day, assets.place_locality AS locality,
            assets.place_region AS region, assets.place_country_code AS country_code,
            COUNT(*) AS n
       FROM assets ${bound.sql}
      GROUP BY day, locality, region, country_code`,
    bound.params,
  );
  const days = new Map<string, { count: number; labels: Map<string, number> }>();
  for (const row of rows) {
    const day = days.get(row.day) ?? { count: 0, labels: new Map<string, number>() };
    day.count += row.n;
    const label = placeLabel(row.locality, row.region, row.country_code);
    if (label !== null) day.labels.set(label, (day.labels.get(label) ?? 0) + row.n);
    days.set(row.day, day);
  }
  return [...days]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, MAX_PHOTO_DAYS)
    .map(([date, day]) => ({ date, count: day.count, place: mostCommonLabel(day.labels) }));
}

interface PhotoRow {
  id: string;
  captured_at: string;
  has_place: number;
  locality: string | null;
  region: string | null;
  country_code: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
}

function toPlace(row: PhotoRow): ServicePlace | null {
  const locality = nonEmpty(row.locality);
  const region = nonEmpty(row.region);
  const countryCode = nonEmpty(row.country_code);
  if (row.has_place === 0 || (locality === null && region === null && countryCode === null)) {
    return null;
  }
  return { label: placeLabel(locality, region, countryCode), locality, region, countryCode };
}

/** Visible people per asset, by name. Hidden, excluded and merged-away people never appear. */
async function visiblePeopleByAsset(
  assetIds: readonly string[],
  db?: SqliteDb,
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const rows = await readBulk<{ asset_id: string; id: string; name: string }>(
    peopleDb(db),
    `SELECT DISTINCT f.asset_id AS asset_id, p.id AS id, p.name AS name
       FROM faces f JOIN people p ON p.id = f.person_id
      WHERE f.asset_id IN (SELECT value FROM json_each(?))
        AND f.hidden = 0 AND p.merged_into IS NULL AND p.hidden = 0 AND p.excluded = 0
      ORDER BY p.name, p.id`,
    [JSON.stringify(assetIds)],
  );
  return rows.reduce(
    (acc, row) =>
      acc.set(row.asset_id, [...(acc.get(row.asset_id) ?? []), { id: row.id, name: row.name }]),
    new Map<string, Array<{ id: string; name: string }>>(),
  );
}

/** The wire shape of each id that still passes `where`, in the order given. */
export async function hydratePhotos(
  where: SearchWhere,
  assetIds: readonly string[],
  db?: SqliteDb,
): Promise<ServicePhoto[]> {
  if (assetIds.length === 0) return [];
  const bound = searchWhereSql(where, assetIdsPredicate(assetIds));
  const [rows, people] = await Promise.all([
    readBulk<PhotoRow>(
      assetsDb(db),
      `SELECT assets.id AS id, assets.captured_at AS captured_at,
              assets.place IS NOT NULL AS has_place, assets.place_locality AS locality,
              assets.place_region AS region, assets.place_country_code AS country_code,
              assets.gps_lat AS gps_lat, assets.gps_lng AS gps_lng
         FROM assets ${bound.sql}`,
      bound.params,
    ),
    visiblePeopleByAsset(assetIds, db),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  return assetIds.flatMap((assetId) => {
    const row = byId.get(assetId);
    if (row === undefined) return [];
    return [
      {
        assetId,
        capturedAt: row.captured_at,
        place: toPlace(row),
        lat: row.gps_lat,
        lng: row.gps_lng,
        people: people.get(assetId) ?? [],
      },
    ];
  });
}

/** Which of `personIds` are live, visible people: not merged away, hidden or excluded. */
export async function visiblePersonIds(
  personIds: readonly string[],
  db?: SqliteDb,
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = await readBulk<{ id: string }>(
    peopleDb(db),
    `SELECT id FROM people WHERE id IN (${placeholders(personIds.length)})
        AND merged_into IS NULL AND hidden = 0 AND excluded = 0`,
    [...personIds],
  );
  return new Set(rows.map((row) => row.id));
}

/** The library slug and relative path of an asset's primary live file. */
export async function primaryPhotoAddress(
  assetId: string,
  db?: SqliteDb,
): Promise<{ slug: string; path: string; filename: string } | null> {
  const rows = await readBulk<{ slug: string; path: string; filename: string }>(
    assetsDb(db),
    primaryLocationsSql(1),
    [assetId],
  );
  return rows[0] ?? null;
}
