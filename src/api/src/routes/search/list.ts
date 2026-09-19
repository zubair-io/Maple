/**
 * `GET /api/search` — paginated result list.
 *
 * Two pagination modes live side by side (#2129). The default sorts
 * (`captured_desc` / `captured_asc`) answer with `cursorPaging: true` and an
 * opaque `nextCursor`; sending it back seeks with a range predicate on
 * `(captured_at, id)` instead of skipping, so page depth stops costing
 * anything. Every other sort — and the `placeQuery` text/Meili path, whose
 * ordering is a computed relevance rank — keeps `page`/`limit` skip
 * pagination and says so with `cursorPaging: false`. See `cursor.ts` for why
 * each of those can't be seeked, and `list-paging.ts` for the mode decision.
 *
 * `cursorPaging` exists so `nextCursor: null` isn't ambiguous: with it
 * `true` the client knows the seek chain is *exhausted* and must stop, and
 * with it `false` the client knows to keep using `page`. Without that
 * distinction a stale cached `total` sends the grid back to deep SKIP
 * paging the moment the chain ends.
 *
 * The query string becomes a `SearchWhere` once, via `buildSearchWhere`, and
 * the same translated value feeds the page and the count — which is what
 * keeps a large `total` from appearing above an empty grid, the failure the
 * Meilisearch branch shipped once (#2928).
 *
 * Related modules: `list-meili.ts` (the Meilisearch branch and its database
 * fallback contract), `total-cache.ts` (the 30 s `total` cache).
 */

import { Elysia } from 'elysia';
import { buildSearchWhere, searchPage } from '../../db/repos/search.repo.ts';
import { personIdsToDrop } from '../../people/people.repo.ts';
import { personIdsForNames } from '../../people/people-search-filter.repo.ts';
import { projectAsset } from './project.ts';
import {
  clampInt,
  extractDatesFromQuery,
  peopleNames,
  SEARCH_SCOPES,
  SearchQueryT,
  type SearchQuery,
} from './query.ts';
import { appliedDateFilter } from './date-provenance.ts';
import { SORT_OPTIONS } from './sort.ts';
import { cursorFromDoc, encodeCursor } from './cursor.ts';
import { libraryMaps } from './libraries.ts';
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
    // One `now` for both calls: the extraction and its provenance must not
    // disagree across a midnight boundary.
    const now = new Date();
    const resolved = extractDatesFromQuery(query as SearchQuery, now);
    // What the client shows so an inferred window is never invisible (#2956).
    const dateFilter = appliedDateFilter(resolved, query as SearchQuery, now);
    const withDates = dateFilter === undefined ? {} : { dateFilter };
    // Excluded people (#2894) drop unconditionally; hidden people only when
    // the request opted in (see `personIdsToDrop`).
    const dropIds = await personIdsToDrop(resolved.excludeHiddenPeople);
    // The `people` param carries display names; the face clause needs the
    // person ids faces are tagged with. Resolution is async, so it happens
    // here and `buildSearchWhere` stays pure (same contract as `dropIds`).
    const peopleIds = await personIdsForNames(peopleNames(resolved.people));
    const whereOrError = buildSearchWhere(resolved, dropIds, peopleIds);
    if ('error' in whereOrError) {
      set.status = 400;
      return { error: whereOrError.error };
    }
    const where = whereOrError;

    // 10_000 mirrors `limit`'s ceiling below in spirit — a sane cap rather
    // than `Number.MAX_SAFE_INTEGER`, which let `skip = page * limit` blow up
    // into a value the database has to reject/choke on for a trivially-crafted
    // request (#2359).
    const page = clampInt(query.page, 0, 10_000, 0);
    const limit = clampInt(query.limit, 1, 500, 100);

    // A residual placeQuery turns the page into a relevance-ranked one: the
    // translated query carries the full-text match and `searchPage` orders by
    // `bm25()`, tie-breaking on captured_at desc then id for stability. A
    // pure-date query ("2023") has an empty residual placeQuery here, so it
    // bypasses both the Meili path and the full-text path and runs as a plain
    // structured filter on `captured_at`.
    const usingPlaceText = usesPlaceText(resolved);
    const sort = query.sort && SORT_OPTIONS.has(query.sort) ? query.sort : 'captured_desc';

    const paging = resolvePaging(query.cursor, sort, page, limit, usingPlaceText);
    if ('error' in paging) {
      set.status = 400;
      return { error: paging.error };
    }
    const cursorPaging = paging.direction !== null;

    // S7 scope chip: `albums` has no backing field today (PhotoKit
    // assetCollection ids are not stored on the asset). Short-circuit BEFORE
    // the database round-trip so an empty result is cheap, and stamp
    // `notImplemented: true` so the client can surface "Coming soon" instead
    // of an empty grid. `buildSearchWhere` already validated the enum, so we
    // know `query.scope === 'albums'` is the only path here.
    if (query.scope === 'albums' && SEARCH_SCOPES.has(query.scope)) {
      return {
        total: 0,
        page,
        limit,
        results: [],
        cursorPaging: false,
        nextCursor: null,
        notImplemented: true as const,
        ...withDates,
      };
    }

    // Phase 7: Meilisearch first when a placeQuery is present and the sidecar
    // is configured; `null` means miss/not-configured/failed, and we fall
    // through to the database's own full-text path (the source of truth).
    const meili = await meiliPage({
      where,
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
        ...withDates,
      };
    }

    // `total` is cached — see `total-cache.ts`. Keyed on the raw query (not
    // `resolved`), matching `buckets.ts`: repeated infinite-scroll requests
    // from the FE resend identical query params. It counts `where` without the
    // seek predicate, which lives only in `searchPage`'s options, so a cursor
    // can't shrink `total` as the user scrolls. Runs concurrently with the
    // page below.
    const [docs, total] = await Promise.all([
      searchPage(where, { sort, limit, skip: paging.skip, cursor: paging.cursor }),
      getCachedTotal(query as SearchQuery, where),
    ]);

    const { libs, idToSlug } = await libraryMaps();
    const results = docs.map((d) => projectAsset(d, libs, idToSlug));
    // A short page is the last page: no cursor, so the client stops. A full
    // page always mints one, even if the next fetch turns out empty — knowing
    // that would cost an extra row read per request.
    const nextCursor =
      paging.direction !== null && docs.length === limit
        ? encodeCursor(cursorFromDoc(docs[docs.length - 1]!, paging.direction))
        : null;
    return { total, page, limit, results, cursorPaging, nextCursor, ...withDates };
  },
  { query: SearchQueryT },
);
