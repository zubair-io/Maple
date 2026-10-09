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
 * cache rather than in front of it. They read different rows for different
 * reasons and neither needs the other's answer, so they run together (#4443)
 * — and a request with no `people` filter never issues the name lookup at
 * all, while the drop lookup only reads hidden people when the request opted
 * in. The 400 comes back as a `Response` so the caller returns it unchanged.
 */

import { buildSearchWhere } from '../../db/repos/search.repo.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { personIdsToDrop } from '../../people/people.repo.ts';
import { personIdsForNames } from '../../people/people-search-filter.repo.ts';
import { peopleNames, type SearchQuery } from './query.ts';

/** The person ids a search drops and the ones its `people` filter names. */
export interface PeopleIds {
  /** Excluded people always; hidden people when the request opted in. */
  dropIds: string[];
  /** Ids for the `people` display names, or null when none were given. */
  peopleIds: string[] | null;
}

/** Both id sets a search's translated query needs, resolved concurrently. */
export async function resolvePeopleIds(query: SearchQuery): Promise<PeopleIds> {
  const [dropIds, peopleIds] = await Promise.all([
    personIdsToDrop(query.excludeHiddenPeople),
    personIdsForNames(peopleNames(query.people)),
  ]);
  return { dropIds, peopleIds };
}

/** The translated query for `query`, or the 400 to answer instead. */
export async function resolveSearchScope(query: SearchQuery): Promise<SearchWhere | Response> {
  const { dropIds, peopleIds } = await resolvePeopleIds(query);
  const where = buildSearchWhere(query, dropIds, peopleIds);
  if ('error' in where) return Response.json({ error: where.error }, { status: 400 });
  return where;
}
