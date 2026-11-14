/**
 * Free-text place matching for the service photo search.
 *
 * A photo's place is matched on its locality, region, country (stored name, ISO code and English
 * name), Nominatim display name and every address part, ignoring case and diacritics, as whole
 * words: "windham" finds Windham and Windham County, "sao paulo" finds São Paulo, "paris" does not
 * find Parish Road. SQLite folds ASCII only, so matching runs here over the owner's distinct
 * geocode results, and the photos are then selected by {@link PLACE_KEY_SQL}.
 */

import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';
import { searchWhereSql, type SearchWhere } from './search.where.ts';
import { PLACE_KEY_SQL } from './service-photos.where.ts';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** Lower-case, diacritics stripped, every run of non-alphanumerics a single space. */
function foldPlaceText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The English name of an ISO 3166-1 alpha-2 code, or null when the code names no region. */
export function countryName(code: string | null): string | null {
  if (code === null || !/^[a-z]{2}$/i.test(code)) return null;
  try {
    const name = regionNames.of(code.toUpperCase());
    return name === undefined || name === code.toUpperCase() ? null : name;
  } catch {
    return null;
  }
}

/** `json_extract` of the address object keeps its JSON subtype, so it nests as an object. */
type PlaceKey = [string | null, string | null, string | null, string | null, unknown];

function addressValues(address: unknown): string[] {
  return address !== null && typeof address === 'object'
    ? Object.values(address).filter((value): value is string => typeof value === 'string')
    : [];
}

function keyFields(key: PlaceKey): string[] {
  const [locality, region, countryCode, displayName, address] = key;
  return [
    locality,
    region,
    locality !== null && region !== null ? `${locality}, ${region}` : null,
    countryCode,
    countryName(countryCode),
    displayName,
    ...addressValues(address),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Whether `needle` (already folded) appears as whole words in one of the place's fields. */
function placeKeyMatches(key: PlaceKey, needle: string): boolean {
  return keyFields(key).some((field) => ` ${foldPlaceText(field)} `.includes(` ${needle} `));
}

/**
 * The distinct place keys among the photos `scope` admits that match `query`. Empty when nothing
 * matches, including when the query folds to nothing at all.
 */
export async function matchingPlaceKeys(
  scope: SearchWhere,
  query: string,
  dbOverride?: SqliteDb,
): Promise<string[]> {
  const needle = foldPlaceText(query);
  if (needle.length === 0) return [];
  const where = searchWhereSql(scope, { sql: 'assets.place IS NOT NULL', params: [] });
  const rows = await readBulk<{ place_key: string }>(
    assetsDb(dbOverride),
    `SELECT DISTINCT ${PLACE_KEY_SQL} AS place_key FROM assets ${where.sql}`,
    where.params,
  );
  return rows
    .filter((row) => placeKeyMatches(JSON.parse(row.place_key) as PlaceKey, needle))
    .map((row) => row.place_key);
}
