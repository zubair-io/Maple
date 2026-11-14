/**
 * `POST /api/service/photos/search`: resolve the request into the owner-scoped filters, then answer
 * it one of two ways.
 *
 * Without `query`, the filters alone select the photos: `total` and `days` count every match and
 * pages seek newest first. With `query`, the text goes through the app's own hybrid search
 * (`routes/search/ranked-window.ts` — the in-process engine, or the database's full-text index
 * while it is unavailable) with the filters applied inside the ranking. The answer is then the
 * request's ranked window — the best few hundred matches, widened further when the filters thin
 * it — and `total` and `days` describe that window. Only a request with nothing but `query` keeps
 * relevance order; any other filter sorts the window newest first.
 */

import type { ServiceApiIdentity } from '../../auth/service-api-keys.ts';
import { personIdsToDrop } from '../../db/repos/people.visibility.ts';
import { matchingPlaceKeys } from '../../db/repos/service-photos.place.ts';
import {
  countPhotos,
  hydratePhotos,
  pagePhotoIds,
  photoDays,
  visiblePersonIds,
  type PhotoDay,
  type ServicePhoto,
} from '../../db/repos/service-photos.repo.ts';
import { assetIdsPredicate, ownerPhotoWhere } from '../../db/repos/service-photos.where.ts';
import { toTextFilter } from '../../db/repos/search.fts.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { requestWindow } from '../search/ranked-window.ts';
import { decodeCursor, encodeCursor, requestFingerprint, type PhotoCursor } from './cursor.ts';
import type { PhotoSearchRequest } from './search-body.ts';

/** Ranked-window size a `query` request asks for: one ladder step, the same for every page. */
const QUERY_WINDOW_NEED = 300;

export interface PhotoSearchResponse {
  total: number;
  days: PhotoDay[];
  photos: ServicePhoto[];
  nextCursor: string | null;
}

export type PhotoSearchOutcome = PhotoSearchResponse | 'invalid_cursor';

const EMPTY: PhotoSearchResponse = { total: 0, days: [], photos: [], nextCursor: null };

async function filteredSearch(
  where: SearchWhere,
  request: PhotoSearchRequest,
  cursor: PhotoCursor | null,
  fingerprint: string,
): Promise<PhotoSearchOutcome> {
  if (cursor?.kind === 'offset') return 'invalid_cursor';
  const [total, days, page] = await Promise.all([
    countPhotos(where),
    photoDays(where),
    pagePhotoIds(where, cursor?.after ?? null, request.limit + 1),
  ]);
  const served = page.slice(0, request.limit);
  const last = served.at(-1);
  return {
    total,
    days,
    photos: await hydratePhotos(
      where,
      served.map((photo) => photo.assetId),
    ),
    nextCursor:
      page.length > request.limit && last
        ? encodeCursor(fingerprint, { kind: 'seek', after: last })
        : null,
  };
}

function onlyQuery(request: PhotoSearchRequest): boolean {
  return (
    request.personIds.length === 0 &&
    request.place === null &&
    request.capturedFrom === null &&
    request.capturedTo === null
  );
}

async function rankedSearch(
  where: SearchWhere,
  request: PhotoSearchRequest & { query: string },
  cursor: PhotoCursor | null,
  fingerprint: string,
): Promise<PhotoSearchOutcome> {
  if (cursor?.kind === 'seek') return 'invalid_cursor';
  const window = await requestWindow({
    where: { ...where, match: toTextFilter(request.query) },
    text: request.query,
    need: QUERY_WINDOW_NEED,
  });
  const rows = onlyQuery(request)
    ? window.rows
    : [...window.rows].sort(
        (a, b) =>
          (b.captured_at ?? '').localeCompare(a.captured_at ?? '') || b.id.localeCompare(a.id),
      );
  const ordered = rows.map((row) => row.id);
  const offset = cursor?.offset ?? 0;
  const pageIds = ordered.slice(offset, offset + request.limit);
  // The window has already folded its stacks, keeping a JPEG whose RAW did not match the text;
  // folding again without the text would drop that survivor from the page and the days.
  const windowRows: SearchWhere = { ...where, foldStacks: false };
  const [days, photos] = await Promise.all([
    ordered.length === 0 ? Promise.resolve([]) : photoDays(windowRows, assetIdsPredicate(ordered)),
    hydratePhotos(windowRows, pageIds),
  ]);
  const nextOffset = offset + request.limit;
  return {
    total: ordered.length,
    days,
    photos,
    nextCursor:
      nextOffset < ordered.length
        ? encodeCursor(fingerprint, { kind: 'offset', offset: nextOffset })
        : null,
  };
}

export async function searchPhotos(
  identity: ServiceApiIdentity,
  request: PhotoSearchRequest,
): Promise<PhotoSearchOutcome> {
  const fingerprint = requestFingerprint(request);
  const cursor = request.cursor === null ? null : decodeCursor(request.cursor, fingerprint);
  if (request.cursor !== null && cursor === null) return 'invalid_cursor';

  const [dropped, visible] = await Promise.all([
    personIdsToDrop(undefined),
    visiblePersonIds(request.personIds),
  ]);
  if (visible.size < request.personIds.length) return EMPTY;

  const scope = ownerPhotoWhere(identity.ownerId, dropped);
  const placeKeys = request.place === null ? null : await matchingPlaceKeys(scope, request.place);
  if (placeKeys !== null && placeKeys.length === 0) return EMPTY;

  const where = ownerPhotoWhere(identity.ownerId, dropped, {
    personIds: request.personIds,
    placeKeys,
    capturedFrom: request.capturedFrom,
    capturedTo: request.capturedTo,
  });
  return request.query === null
    ? filteredSearch(where, request, cursor, fingerprint)
    : rankedSearch(where, { ...request, query: request.query }, cursor, fingerprint);
}
