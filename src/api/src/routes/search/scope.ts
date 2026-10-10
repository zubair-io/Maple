/**
 * The scope an aggregation runs over: the translated query, with this
 * request's people filters already resolved to ids.
 *
 * `/search/facets` and `/search/buckets` both said the same thing in their own
 * words — facet counts and timeline buckets have to agree with the result list
 * when a person filter is active, or the UI offers a filter that returns
 * nothing and a count nobody can reproduce. Agreement stated twice in two
 * comments is agreement that can lapse; as one function it cannot.
 *
 * Both lookups are round trips, which is why `/buckets` keeps this behind its
 * cache rather than in front of it. The 400 comes back as a `Response` so the
 * caller returns it unchanged.
 */

import { buildSearchWhere } from '../../db/repos/search.repo.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { personIdsToDrop } from '../../people/people.repo.ts';
import { personIdsForNames } from '../../people/people-search-filter.repo.ts';
import { extractDatesFromQuery, peopleNames, type SearchQuery } from './query.ts';

async function translate(query: SearchQuery): Promise<SearchWhere | { error: string }> {
  // Excluded people (#2894) drop unconditionally; hidden people only when the request opted in
  // (see `personIdsToDrop`). The `people` param carries display names; the face clause needs
  // the person ids faces are tagged with, resolved here so `buildSearchWhere` stays pure.
  const dropIds = await personIdsToDrop(query.excludeHiddenPeople);
  const peopleIds = await personIdsForNames(peopleNames(query.people));
  return buildSearchWhere(query, dropIds, peopleIds);
}

/** The translated query for `query`, or the 400 to answer instead. */
export async function resolveSearchScope(query: SearchQuery): Promise<SearchWhere | Response> {
  const where = await translate(query);
  if ('error' in where) return Response.json({ error: where.error }, { status: 400 });
  return where;
}

/**
 * What a relevance-ranked search runs on: the request with its natural-language dates resolved
 * ("harbour in 2023" → text `harbour`, window 2023), that request translated, and the residual
 * text an engine ranks (null when nothing is left, e.g. a bare "2023"). The list and the facets
 * both take their in-process candidates' text and filters from here, so the two cannot disagree
 * about the date window.
 */
export interface RankedSearchScope {
  resolved: SearchQuery;
  where: SearchWhere;
  childQuery: string | null;
}

export async function resolveRankedScope(
  query: SearchQuery,
  now: Date = new Date(),
): Promise<RankedSearchScope | { error: string }> {
  const resolved = extractDatesFromQuery(query, now);
  const where = await translate(resolved);
  if ('error' in where) return where;
  const text = resolved.placeQuery?.trim() ?? '';
  return { resolved, where, childQuery: text.length > 0 ? text : null };
}
