/**
 * The Meilisearch branch of `GET /api/search`.
 *
 * When a residual `placeQuery` is set and a Meilisearch sidecar is
 * configured, we query Meilisearch first (typo-tolerant, ranked) and
 * re-fetch the full asset rows from the database so the projection stays
 * source-of-truth. On a miss or an error the caller falls back to the
 * database's own full-text path, which is why this returns `null` rather
 * than throwing — the route must keep answering 200s when Meilisearch is
 * down.
 *
 * Meilisearch is a separate service and is untouched by the SQLite cutover
 * (#3787). What moved is the second half: the re-fetch is
 * `searchByMapleIds` now rather than a `maple_id: { $in: … }` find, and the
 * structured filters reach it as the same translated `SearchWhere` the
 * database path uses.
 *
 * Split out of `list.ts` in #2129: adding seek pagination pushed the route
 * handler past the complexity gate, and this branch is the largest
 * self-contained piece of it. Behaviour is unchanged.
 *
 * This path is never seekable — Meilisearch orders by relevance, which is
 * not a stored column — so it paginates by `offset`/`limit` and the caller
 * stamps `nextCursor: null` on the response.
 */

import { searchByMapleIds, type SearchWhere } from '../../db/sqlite/repos/search.repo.ts';
import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { child as childLogger } from '../../log.ts';
import { projectAsset, type SearchResult } from './project.ts';
import { libraryMaps } from './libraries.ts';
import { peopleNames, widenFromDate, widenToDate, type SearchQuery } from './query.ts';

const searchLog = childLogger('search');

export interface MeiliPage {
  total: number;
  results: SearchResult[];
}

export interface MeiliPageInput {
  /** The caller's translated query — every filter except the free text. */
  where: SearchWhere;
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
 * `peopleNames` in `query.ts`). Meili filters by name directly; the
 * re-fetch below additionally applies the translated query's id-based clause. */
function meiliPeople(resolved: SearchQuery): string[] | undefined {
  const names = peopleNames(resolved.people);
  return names.length > 0 ? names : undefined;
}

/**
 * A wire date bound as a canonical ISO instant, shifted by `offsetMs`, or
 * `undefined` when it isn't a parseable date.
 *
 * Normalising is load-bearing, not cosmetic. `from`/`to` arrive as
 * `t.Optional(t.String())` with no date validation, `widenFromDate` /
 * `widenToDate` return a non-`YYYY-MM-DD` string unmodified, and
 * `meilisearch-filter.ts` interpolates these bounds straight into the filter
 * expression (`capturedAt >= "${capturedFrom}"`) — it escapes `folderId` and
 * person names but trusts the caller for these. A bound carrying a double
 * quote would therefore close the literal early and append attacker-chosen
 * clauses, enough to lift the `hidden` exclusion or the `folderId` scope. A
 * canonical instant cannot carry a quote.
 *
 * An unparseable bound is dropped rather than guessed at. The database
 * predicate still applies it, so results stay correct either way.
 */
function isoInstant(bound: string | undefined, offsetMs: number): string | undefined {
  if (bound === undefined) return undefined;
  const ms = new Date(bound).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms + offsetMs).toISOString();
}

/**
 * The capture-date window in the form Meilisearch takes it: an inclusive
 * lower bound and an EXCLUSIVE upper bound.
 *
 * Pushing this down is not an optimisation. Meilisearch returns one page of
 * `limit` ids ranked by relevance; applying the window only to that page (as
 * the re-fetch below does) hides every in-window match that ranked
 * past it, and leaves `estimatedTotal` counting text matches from outside
 * the window entirely — an empty grid under a large result count.
 *
 * `resolved.to` is inclusive and already widened to the end of its day, so
 * the exclusive bound is one millisecond past it: at the millisecond
 * resolution `capturedAt` is stored in, `< to + 1ms` selects the same set as
 * `<= to`, which keeps this in step with the `captured_at <= ?` predicate.
 */
function capturedWindow(resolved: SearchQuery): {
  capturedFrom?: string;
  capturedBefore?: string;
} {
  const from = isoInstant(resolved.from ? widenFromDate(resolved.from) : undefined, 0);
  const before = isoInstant(resolved.to ? widenToDate(resolved.to) : undefined, 1);
  return {
    ...(from === undefined ? {} : { capturedFrom: from }),
    ...(before === undefined ? {} : { capturedBefore: before }),
  };
}

/**
 * Filters that `buildSearchWhere` turns into a SQL predicate and that the
 * Meilisearch query has no way to express — the index carries no
 * corresponding filterable attribute.
 *
 * They cannot simply be applied after the fact. Meili returns one page of
 * `limit` relevance-ranked ids; intersecting that page in the database can
 * only REMOVE rows, never reach a match ranked past it, and leaves `total`
 * counting documents the filter would have excluded (#2928, #2932). So when
 * one is present the branch declines outright and the route falls through to
 * the database's own full-text path, which applies every filter in a single
 * query and counts correctly.
 *
 * That costs relevance ranking on those queries and is still the right
 * trade: the alternative is a confidently wrong answer.
 */
const DATABASE_ONLY_FILTERS = [
  'q',
  'camera',
  'lens',
  'isoMin',
  'isoMax',
  'apertureMin',
  'apertureMax',
  'focalMin',
  'focalMax',
  'month',
  'rating',
  'flag',
  'color',
  'ext',
  'pathPrefix',
  'hasCapturedAt',
  'place',
  'excludeHiddenPeople',
] as const;

/**
 * Params the filter builder reads as a boolean opt-in: they add a clause
 * ONLY on the exact string `'true'`. Treating any non-empty value as active
 * would send `hasCapturedAt=false` down the database path for a filter that
 * never existed — a needless loss of relevance ranking.
 */
const TRUE_ONLY_FLAGS: ReadonlySet<string> = new Set(['hasCapturedAt', 'excludeHiddenPeople']);

function isSet(value: unknown, key?: string): boolean {
  if (typeof value !== 'string') return false;
  return key !== undefined && TRUE_ONLY_FLAGS.has(key) ? value === 'true' : value.trim().length > 0;
}

/**
 * Which of the caller's filters force the database path, empty when the whole
 * query is expressible in Meilisearch.
 *
 * Exported for the coverage test that walks the wire schema: a param added
 * to `SearchQueryT` without being classified here would silently resume
 * post-filtering a single page.
 */
export function unpushableFilters(resolved: SearchQuery): string[] {
  const named = DATABASE_ONLY_FILTERS.filter((key) => isSet(resolved[key], key));
  // `photos` and absent are no-ops in the filter builder; `places`/`people` add a
  // presence clause with no Meili counterpart. Anything else is rejected
  // upstream — treat it as unpushable rather than assume it is inert.
  const scope = resolved.scope?.trim() ?? '';
  return scope === '' || scope === 'photos' ? named : [...named, 'scope'];
}

/** Comma-separated wire list → trimmed values, matching `buildFilter`. */
function commaList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Tri-state screenshot filter; any other value leaves it unconstrained,
 * exactly as `buildFilter` does. */
function screenshotFlag(value: string | undefined): boolean | undefined {
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

/** The vision + screenshot filters, all already filterable on the index. */
function visionFilters(resolved: SearchQuery): {
  sceneType?: string;
  activity?: string;
  subjects?: string[];
  isScreenshot?: boolean;
} {
  const subjects = commaList(resolved.subjects);
  const isScreenshot = screenshotFlag(resolved.isScreenshot);
  return {
    ...(isSet(resolved.sceneType) ? { sceneType: resolved.sceneType!.trim() } : {}),
    ...(isSet(resolved.activity) ? { activity: resolved.activity!.trim() } : {}),
    ...(subjects.length === 0 ? {} : { subjects }),
    ...(isScreenshot === undefined ? {} : { isScreenshot }),
  };
}

/**
 * One page of Meilisearch-ranked results, or `null` when the sidecar isn't
 * configured, this isn't a text query, or the query failed (logged; the
 * caller falls through to the database full-text path).
 */
export async function meiliPage(input: MeiliPageInput): Promise<MeiliPage | null> {
  const { where, resolved, libraryId, skip, limit } = input;
  const meili = meilisearchClient();
  if (!usesPlaceText(resolved) || !meili.isConfigured()) return null;

  // Correctness outranks ranking: see DATABASE_ONLY_FILTERS.
  const unpushable = unpushableFilters(resolved);
  if (unpushable.length > 0) {
    searchLog.debug(
      { unpushable, placeQuery: resolved.placeQuery },
      'meilisearch declined; filters have no index counterpart, using the database',
    );
    return null;
  }

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
      ...visionFilters(resolved),
      semantic: meili.semanticConfigured(),
      includeHidden: resolved.hidden === 'all',
      onlyHidden: resolved.hidden === 'only',
      offset: skip,
      limit,
    });
    if (hit.ids.length === 0) return { total: hit.estimatedTotal, results: [] };

    // Fetch full asset rows for the Meilisearch ids, in the order Meilisearch
    // ranked them. `searchByMapleIds` drops the free-text half of `where` and
    // keeps every structured filter — the sidecar already did the text match,
    // and re-running it over a typo-tolerant hit ("Musum" → "Museum") would
    // zero the result. Ids with no surviving row drop out, which is what a
    // mid-flight hard delete looks like.
    const docs = await searchByMapleIds(where, hit.ids);
    const { libs, idToSlug } = await libraryMaps();
    return {
      total: hit.estimatedTotal,
      results: docs.map((d) => projectAsset(d, libs, idToSlug)),
    };
  } catch (err) {
    // Log and let the caller fall through to the database's own full-text
    // path. The route still returns a 200 — the operator sees this in the
    // logs.
    searchLog.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        placeQuery: resolved.placeQuery,
      },
      'meilisearch query failed; falling back to the database full-text path',
    );
    return null;
  }
}
