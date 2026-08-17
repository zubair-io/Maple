/**
 * The Meilisearch branch of `GET /api/search`.
 *
 * When a residual `placeQuery` is set and a Meilisearch sidecar is
 * configured, we query Meilisearch first (typo-tolerant, ranked) and
 * re-fetch the full asset rows from Mongo so the projection stays
 * source-of-truth. On a miss or an error the caller falls back to the Mongo
 * `$text` path, which is why this returns `null` rather than throwing —
 * the route must keep answering 200s when Meilisearch is down.
 *
 * Split out of `list.ts` in #2129: adding seek pagination pushed the route
 * handler past the complexity gate, and this branch is the largest
 * self-contained piece of it. Behaviour is unchanged.
 *
 * This path is never seekable — Meilisearch orders by relevance, which is
 * not a stored Mongo field — so it paginates by `offset`/`limit` and the
 * caller stamps `nextCursor: null` on the response.
 */

import type { Collection, Filter, ObjectId } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../../indexer/libraries.cache.ts';
import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { child as childLogger } from '../../log.ts';
import { projectAsset, type SearchResult } from './project.ts';
import {
  applyLiveFilter,
  peopleNames,
  widenFromDate,
  widenToDate,
  type SearchQuery,
} from './query.ts';

const searchLog = childLogger('search');

export interface MeiliPage {
  total: number;
  results: SearchResult[];
}

export interface MeiliPageInput {
  coll: Collection<AssetDoc>;
  /** The caller's structured filter, pre-`applyLiveFilter`. */
  filter: Filter<AssetDoc>;
  /** Date-resolved query (`extractDatesFromQuery` output). */
  resolved: SearchQuery;
  /** Library scope, straight off the wire. */
  libraryId: string | undefined;
  skip: number;
  limit: number;
}

/** True when there is residual free text for the relevance path to rank. */
export function usesPlaceText(resolved: SearchQuery): boolean {
  return typeof resolved.placeQuery === 'string' && resolved.placeQuery.trim().length > 0;
}

/** Person names for the Meili `people` filter, or `undefined` when the
 * explicit person picker is empty (parsing shared with the routes via
 * `peopleNames` in `query.ts`). Meili filters by name directly; the Mongo
 * re-fetch below additionally applies `buildFilter`'s id-based clause. */
function meiliPeople(resolved: SearchQuery): string[] | undefined {
  const names = peopleNames(resolved.people);
  return names.length > 0 ? names : undefined;
}

/**
 * The capture-date window in the form Meilisearch takes it: an inclusive
 * lower bound and an EXCLUSIVE upper bound.
 *
 * Pushing this down is not an optimisation. Meilisearch returns one page of
 * `limit` ids ranked by relevance; applying the window only to that page (as
 * the Mongo re-fetch below does) hides every in-window match that ranked
 * past it, and leaves `estimatedTotal` counting text matches from outside
 * the window entirely — an empty grid under a large result count.
 *
 * `resolved.to` is inclusive and already widened to the end of its day, so
 * the exclusive bound is one millisecond past it: at the millisecond
 * resolution `capturedAt` is stored in, `< to + 1ms` selects the same set as
 * `<= to`, which keeps this in step with the Mongo `$lte` predicate.
 */
function capturedWindow(resolved: SearchQuery): {
  capturedFrom?: string;
  capturedBefore?: string;
} {
  const from = resolved.from ? widenFromDate(resolved.from) : undefined;
  const to = resolved.to ? widenToDate(resolved.to) : undefined;
  const toMs = to === undefined ? Number.NaN : new Date(to).getTime();
  // An unparseable bound is left to the Mongo predicate rather than guessed
  // at — a malformed `capturedBefore` would narrow the candidate set.
  const before = Number.isNaN(toMs) ? undefined : new Date(toMs + 1).toISOString();
  return {
    ...(from === undefined ? {} : { capturedFrom: from }),
    ...(before === undefined ? {} : { capturedBefore: before }),
  };
}

/**
 * One page of Meilisearch-ranked results, or `null` when the sidecar isn't
 * configured, this isn't a text query, or the query failed (logged; the
 * caller falls through to Mongo `$text`).
 */
export async function meiliPage(input: MeiliPageInput): Promise<MeiliPage | null> {
  const { coll, filter, resolved, libraryId, skip, limit } = input;
  const meili = meilisearchClient();
  if (!usesPlaceText(resolved) || !meili.isConfigured()) return null;

  try {
    // Thread the caller's hidden mode into the Meili candidate set. Meili
    // defaults to excluding hidden docs, so without this the Mongo
    // `hidden: true` intersection for `only` runs against an already
    // hidden-free id set and always comes back empty (#2358). `only` is
    // pushed all the way into the Meili filter (`hidden = true`) so each
    // candidate page stays dense with rows the re-fetch will keep.
    const hit = await meili.search(resolved.placeQuery!.trim(), {
      folderId: libraryId,
      people: meiliPeople(resolved),
      ...capturedWindow(resolved),
      semantic: meili.semanticConfigured(),
      includeHidden: resolved.hidden === 'all',
      onlyHidden: resolved.hidden === 'only',
      offset: skip,
      limit,
    });
    if (hit.ids.length === 0) return { total: hit.estimatedTotal, results: [] };

    // Fetch full asset summaries for the Meilisearch ids. Strip `$text` from
    // the filter — Meilisearch already did the text match, and re-running
    // Mongo `$text` on a typo-tolerant hit ("Musum" → "Museum") would zero
    // the result. The structured filters (camera, lens, ext, …) and the
    // soft-delete clause still apply.
    const filterWithoutText = { ...filter };
    delete (filterWithoutText as Record<string, unknown>).$text;
    const restrict = applyLiveFilter({
      ...filterWithoutText,
      maple_id: { $in: hit.ids },
    } as unknown as Filter<AssetDoc>);

    const docs = (await coll.find(restrict).toArray()) as Array<AssetDoc & { _id: ObjectId }>;
    const byId = new Map<string, AssetDoc & { _id: ObjectId }>();
    for (const d of docs) {
      const mapleId = (d as unknown as { maple_id?: string }).maple_id;
      if (typeof mapleId === 'string') byId.set(mapleId, d);
    }
    // Preserve Meilisearch's relevance order. Drop ids that no longer exist
    // in Mongo (rare; e.g. a mid-flight hard delete).
    const ordered = hit.ids
      .map((id) => byId.get(id))
      .filter((d): d is AssetDoc & { _id: ObjectId } => d !== undefined);

    const [libs, idToSlug] = await Promise.all([
      loadLibraryRoots().catch(() => new Map<string, string>()),
      loadLibraryIdToSlug().catch(() => new Map<string, string>()),
    ]);
    return {
      total: hit.estimatedTotal,
      results: ordered.map((d) => projectAsset(d, libs, idToSlug)),
    };
  } catch (err) {
    // Log and let the caller fall through to the Mongo `$text` path. The
    // route still returns a 200 — the operator sees this in the logs.
    searchLog.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        placeQuery: resolved.placeQuery,
      },
      'meilisearch query failed; falling back to mongo $text',
    );
    return null;
  }
}
