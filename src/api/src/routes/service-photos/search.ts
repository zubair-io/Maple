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
 *
 * Every later page of a `query` search is ranked from its cursor's rank pin: the same engine at the
 * same depths, over the same resolved filters. When that engine cannot answer, or the filters now
 * resolve differently (a place newly geocoded, a person excluded), the page is refused rather than
 * cut from a differently ordered window, and the client starts again from the first page.
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
import { pinnedWindow, pinOf, type RankPin } from '../search/pinned-window.ts';
import { requestWindow, type EngineWindow, type WindowRequest } from '../search/ranked-window.ts';
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

export type PhotoSearchOutcome = PhotoSearchResponse | 'invalid_cursor' | 'ranking_changed';

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

/** The window a page is cut from: a fresh ranking for the first page, the pinned one after. */
function servedWindow(ranking: WindowRequest, pin: RankPin | null) {
  return pin === null
    ? requestWindow(ranking).then((window) => ({ window, pin: pinOf(window, ranking) }))
    : pinnedWindow(ranking, pin);
}

/** The window's ids in the order the response serves them. */
function servedOrder(window: EngineWindow, request: PhotoSearchRequest): string[] {
  const rows = onlyQuery(request)
    ? window.rows
    : [...window.rows].sort(
        (a, b) =>
          (b.captured_at ?? '').localeCompare(a.captured_at ?? '') || b.id.localeCompare(a.id),
      );
  return rows.map((row) => row.id);
}

/** One page of a ranked window's `ordered` ids, starting at `offset`. */
async function windowPage(
  where: SearchWhere,
  ordered: readonly string[],
  offset: number,
  limit: number,
  cursorAt: (offset: number) => string,
): Promise<PhotoSearchResponse> {
  // The window has already folded its stacks, keeping a JPEG whose RAW did not match the text;
  // folding again without the text would drop that survivor from the page and the days.
  const windowRows: SearchWhere = { ...where, foldStacks: false };
  const [days, photos] = await Promise.all([
    ordered.length === 0 ? Promise.resolve([]) : photoDays(windowRows, assetIdsPredicate(ordered)),
    hydratePhotos(windowRows, ordered.slice(offset, offset + limit)),
  ]);
  const nextOffset = offset + limit;
  return {
    total: ordered.length,
    days,
    photos,
    nextCursor: nextOffset < ordered.length ? cursorAt(nextOffset) : null,
  };
}

async function rankedSearch(
  where: SearchWhere,
  request: PhotoSearchRequest & { query: string },
  cursor: PhotoCursor | null,
  fingerprint: string,
): Promise<PhotoSearchOutcome> {
  if (cursor?.kind === 'seek') return 'invalid_cursor';
  const ranking = {
    where: { ...where, match: toTextFilter(request.query) },
    text: request.query,
    need: QUERY_WINDOW_NEED,
  };
  const served = await servedWindow(ranking, cursor?.pin ?? null);
  if (served === null) return 'ranking_changed';
  const { pin } = served;
  return windowPage(
    where,
    servedOrder(served.window, request),
    cursor?.offset ?? 0,
    request.limit,
    (offset) => encodeCursor(fingerprint, { kind: 'offset', offset, pin }),
  );
}

export async function searchPhotos(
  identity: ServiceApiIdentity,
  request: PhotoSearchRequest,
): Promise<PhotoSearchOutcome> {
  const fingerprint = requestFingerprint(request);
  const cursor = request.cursor === null ? null : decodeCursor(request.cursor, fingerprint);
  if (request.cursor !== null && cursor === null) return 'invalid_cursor';

  // Sorted so the same library resolves to the same filters, which a rank pin is a digest of.
  const [dropped, visible] = await Promise.all([
    personIdsToDrop(undefined).then((ids) => ids.sort()),
    visiblePersonIds(request.personIds),
  ]);
  if (visible.size < request.personIds.length) return EMPTY;

  // Every place a photo has, a stack's JPEG included: the fold below keeps that JPEG when its RAW
  // lacks the place, so discovering keys from folded rows would miss it.
  const scope: SearchWhere = { ...ownerPhotoWhere(identity.ownerId, dropped), foldStacks: false };
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
