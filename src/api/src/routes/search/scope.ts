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

import { buildSearchWhere } from '../../db/sqlite/repos/search.repo.ts';
import type { SearchWhere } from '../../db/sqlite/repos/search.where.ts';
import { personIdsToDrop } from '../../people/people.repo.ts';
import { personIdsForNames } from '../../people/people-search-filter.repo.ts';
import { peopleNames, type SearchQuery } from './query.ts';

/** The translated query for `query`, or the 400 to answer instead. */
export async function resolveSearchScope(query: SearchQuery): Promise<SearchWhere | Response> {
  // Opt-in hidden-people exclusion, then names → ids: the same two id sets the
  // list route resolves, in the same order.
  const dropIds = await personIdsToDrop(query.excludeHiddenPeople);
  const peopleIds = await personIdsForNames(peopleNames(query.people));
  const where = buildSearchWhere(query, dropIds, peopleIds);
  if ('error' in where) return Response.json({ error: where.error }, { status: 400 });
  return where;
}
