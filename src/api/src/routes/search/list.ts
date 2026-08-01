/**
 * `GET /api/search` — paginated result list.
 *
 * Two pagination modes live side by side (#2129). The default sorts
 * (`captured_desc` / `captured_asc`) answer with `cursorPaging: true` and an
 * opaque `nextCursor`; sending it back seeks with a range predicate on
 * `(exif.captured_at, _id)` instead of skipping, so page depth stops costing
 * anything. Every other sort — and the `placeQuery` text/Meili path, whose
 * ordering is a computed `textScore` — keeps `page`/`limit` skip pagination
 * and says so with `cursorPaging: false`. See `cursor.ts` for why each of
 * those can't be seeked, and `list-paging.ts` for the mode decision.
 *
 * `cursorPaging` exists so `nextCursor: null` isn't ambiguous: with it
 * `true` the client knows the seek chain is *exhausted* and must stop, and
 * with it `false` the client knows to keep using `page`. Without that
 * distinction a stale cached `total` sends the grid back to deep SKIP
 * paging the moment the chain ends.
 *
 * Related modules: `list-meili.ts` (the Meilisearch branch and its Mongo
 * `$text` fallback contract), `total-cache.ts` (the 30 s `total` cache).
 */

import { Elysia } from 'elysia';
import type { ObjectId } from 'mongodb';
import type { Filter, Sort } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { hiddenPersonIds } from '../../people/people.repo.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../../indexer/libraries.cache.ts';
import type { AssetDoc } from '../../db/schema.ts';
import { projectAsset } from './project.ts';
import {
  applyLiveFilter,
  buildFilter,
  clampInt,
  extractDatesFromQuery,
  SEARCH_SCOPES,
  SearchQueryT,
  type SearchQuery,
} from './query.ts';
import { pickSort, SORT_OPTIONS } from './sort.ts';
import { cursorFromDoc, encodeCursor } from './cursor.ts';
import { meiliPage, usesPlaceText } from './list-meili.ts';
import { resolvePaging } from './list-paging.ts';
import { getCachedTotal } from './total-cache.ts';

export const listRoute = new Elysia().get(
  '/',
  async ({ query, set }) => {
    // Natural-language dates: resolve "May 5" / "2023" / "last summer" out
    // of placeQuery into structured from/to, and strip the matched span so
    // the residual free-text drives the text/Meili path. Pure-date queries
    // ("2023") leave an empty residual and skip the text path entirely.
    const resolved = extractDatesFromQuery(query as SearchQuery);
    // Only pay for the hidden-people lookup when the caller asked to exclude
    // them (opt-in — see `SearchQuery.excludeHiddenPeople`).
    const hiddenIds = resolved.excludeHiddenPeople === 'true' ? await hiddenPersonIds() : [];
    const filterOrError = buildFilter(resolved, hiddenIds);
    if ('error' in filterOrError) {
      set.status = 400;
      return { error: filterOrError.error };
    }
    const filter = filterOrError;

    // 10_000 mirrors `limit`'s ceiling below in spirit — a sane cap rather
    // than `Number.MAX_SAFE_INTEGER`, which let `skip = page * limit` blow up
    // into a value Mongo has to reject/choke on for a trivially-crafted
    // request (#2359).
    const page = clampInt(query.page, 0, 10_000, 0);
    const limit = clampInt(query.limit, 1, 500, 100);

    // When a residual placeQuery is set, sort by Mongo's textScore first so
    // closer matches lead the page; tie-break on captured_at desc, then _id
    // for pagination stability. Otherwise honour the caller's sort. A
    // pure-date query ("2023") has an empty residual placeQuery here, so it
    // bypasses both the Meili path and the Mongo `$text` path and runs as a
    // plain structured filter on `exif.captured_at`.
    const usingPlaceText = usesPlaceText(resolved);
    const sort = query.sort && SORT_OPTIONS.has(query.sort) ? query.sort : 'captured_desc';

    const paging = resolvePaging(query.cursor, sort, page, limit, usingPlaceText);
    if ('error' in paging) {
      set.status = 400;
      return { error: paging.error };
    }
    const cursorPaging = paging.direction !== null;

    // S7 scope chip: `albums` has no backing field today (PhotoKit
    // assetCollection ids are not stored on AssetDoc). Short-circuit BEFORE
    // the Mongo round-trip so an empty result is cheap, and stamp
    // `notImplemented: true` so the client can surface "Coming soon" instead
    // of an empty grid. `buildFilter` already validated the enum, so we know
    // `query.scope === 'albums'` is the only path here.
    if (query.scope === 'albums' && SEARCH_SCOPES.has(query.scope)) {
      return {
        total: 0,
        page,
        limit,
        results: [],
        cursorPaging: false,
        nextCursor: null,
        notImplemented: true as const,
      };
    }

    const coll = await assetsCollection();
    // Exclude soft-deleted rows from search results. We always wrap the
    // existing filter into a `$and` so a user-supplied `$or` (free-text
    // q + camera) doesn't shadow this constraint.
    const finalFilter = applyLiveFilter(filter);
    // Same reasoning for the seek predicate, which is itself an `$or` in
    // three of its four shapes: `$and` it on rather than merging keys.
    const pagedFilter: Filter<AssetDoc> = paging.seek
      ? ({ $and: [finalFilter, paging.seek] } as Filter<AssetDoc>)
      : finalFilter;

    // Phase 7: Meilisearch first when a placeQuery is present and the sidecar
    // is configured; `null` means miss/not-configured/failed, and we fall
    // through to the Mongo `$text` path (the source of truth) below.
    const meili = await meiliPage({
      coll,
      filter,
      resolved,
      libraryId: query.libraryId,
      skip: paging.skip,
      limit,
    });
    if (meili) {
      return {
        total: meili.total,
        page,
        limit,
        results: meili.results,
        cursorPaging: false,
        nextCursor: null,
      };
    }

    const sortSpec: Sort = usingPlaceText
      ? ({ score: { $meta: 'textScore' }, 'exif.captured_at': -1, _id: 1 } as unknown as Sort)
      : pickSort(sort);

    const find = coll.find(pagedFilter);
    if (usingPlaceText) find.project({ score: { $meta: 'textScore' } });

    // `total` is cached — see `total-cache.ts`. Keyed on the raw query (not
    // `resolved`), matching `buckets.ts`: repeated infinite-scroll requests
    // from the FE resend identical query params. It counts `finalFilter`,
    // never `pagedFilter`, so the seek predicate can't shrink `total` as the
    // user scrolls. Runs concurrently with the find below.
    const totalPromise = getCachedTotal(coll, query as SearchQuery, finalFilter, !usingPlaceText);

    const [docs, total] = await Promise.all([
      find.sort(sortSpec).skip(paging.skip).limit(limit).toArray(),
      totalPromise,
    ]);

    const [libs, idToSlug] = await Promise.all([
      loadLibraryRoots().catch(() => new Map<string, string>()),
      loadLibraryIdToSlug().catch(() => new Map<string, string>()),
    ]);
    const results = docs.map((d) =>
      projectAsset(d as AssetDoc & { _id: ObjectId }, libs, idToSlug),
    );
    // A short page is the last page: no cursor, so the client stops. A full
    // page always mints one, even if the next fetch turns out empty — knowing
    // that would cost an extra document read per request.
    const nextCursor =
      paging.direction !== null && docs.length === limit
        ? encodeCursor(
            cursorFromDoc(docs[docs.length - 1] as AssetDoc & { _id: ObjectId }, paging.direction),
          )
        : null;
    return { total, page, limit, results, cursorPaging, nextCursor };
  },
  { query: SearchQueryT },
);
