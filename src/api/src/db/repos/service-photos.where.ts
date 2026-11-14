/**
 * The filters behind the service photo API (`/api/service/photos*`), as a {@link SearchWhere}.
 *
 * Every statement the API runs starts from {@link ownerPhotoWhere}: the key owner's live, visible,
 * dated still images, with any photo of an excluded person dropped and a RAW+JPEG pair folded into
 * its RAW. The request's own filters are appended to that, so a count, a page, a day histogram and
 * a ranked window all describe the same set of photos.
 *
 * Capture time is `assets.captured_at`, the camera's wall clock from EXIF as the indexer stores it
 * (`indexer/exif.ts`): written with a `Z` suffix, but never shifted from the time zone the camera
 * was set to. Bounds are compared against that wall clock as text.
 */

import type { SearchWhere } from './search.where.ts';
import { excludedPeopleTerm, peopleTerm, type Term } from './search.terms.ts';

/** The request filters, already validated and resolved. */
export interface PhotoFilters {
  /** Visible person ids; a photo must show every one of them. */
  personIds: readonly string[];
  /** {@link PLACE_KEY_SQL} values a photo's place must have, or null for no place filter. */
  placeKeys: readonly string[] | null;
  /** Inclusive wall-clock bounds in the stored `YYYY-MM-DDTHH:MM:SS.sssZ` form. */
  capturedFrom: string | null;
  capturedTo: string | null;
}

const NO_PHOTO_FILTERS: PhotoFilters = {
  personIds: [],
  placeKeys: null,
  capturedFrom: null,
  capturedTo: null,
};

/**
 * One text value per distinct geocode result. The place filter matches distinct keys in memory
 * (diacritic folding needs Unicode tables SQLite does not have) and then selects photos by key.
 */
export const PLACE_KEY_SQL = `json_array(assets.place_locality, assets.place_region,
  assets.place_country_code, json_extract(assets.place, '$.display_name'),
  json_extract(assets.place, '$.address'))`;

function ownerTerms(ownerId: string, droppedPersonIds: readonly string[]): Term[] {
  return [
    { sql: 'assets.owner_id = ?', params: [ownerId] },
    { sql: `assets.media_kind = 'image'`, params: [] },
    { sql: 'assets.captured_at IS NOT NULL', params: [] },
    ...(droppedPersonIds.length === 0 ? [] : [excludedPeopleTerm(droppedPersonIds)]),
  ];
}

function filterTerms(filters: PhotoFilters): Term[] {
  return [
    ...filters.personIds.map((personId) => peopleTerm([personId])),
    ...(filters.placeKeys === null
      ? []
      : [
          {
            sql: `${PLACE_KEY_SQL} IN (SELECT value FROM json_each(?))`,
            params: [JSON.stringify(filters.placeKeys)],
          },
        ]),
    ...(filters.capturedFrom === null
      ? []
      : [{ sql: 'assets.captured_at >= ?', params: [filters.capturedFrom] }]),
    ...(filters.capturedTo === null
      ? []
      : [{ sql: 'assets.captured_at <= ?', params: [filters.capturedTo] }]),
  ];
}

/** The owner's visible photos narrowed by `filters`. */
export function ownerPhotoWhere(
  ownerId: string,
  droppedPersonIds: readonly string[],
  filters: PhotoFilters = NO_PHOTO_FILTERS,
): SearchWhere {
  const terms = [...ownerTerms(ownerId, droppedPersonIds), ...filterTerms(filters)];
  return {
    clauses: terms.map((term) => term.sql),
    params: terms.flatMap((term) => term.params),
    match: { kind: 'none' },
    ownerId,
    hidden: 0,
    month: null,
    foldStacks: true,
  };
}

/** Restricts a statement to a known set of asset ids, such as a ranked window's. */
export function assetIdsPredicate(assetIds: readonly string[]): Term {
  return {
    sql: 'assets.id IN (SELECT value FROM json_each(?))',
    params: [JSON.stringify(assetIds)],
  };
}
