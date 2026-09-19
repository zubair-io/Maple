/**
 * `GET /api/search/facets` — aggregation buckets for FE dropdowns.
 *
 * Twelve aggregations sharing the one translated query, so a faceted UI shows
 * "cameras within the current scope" rather than the global universe. The
 * aggregations themselves live in `db/sqlite/repos/search.facets.ts`, where
 * each one groups a partial index whose keys are its own group keys — the
 * reason this route no longer needs a ten-second timeout to stay up.
 *
 * The one thing that stays here is the person join. The repository counts
 * assets per person *id*; turning those into display names drops the people
 * who are hidden, merged away or still carrying a clustering placeholder, and
 * that is the people repository's business rather than the search layer's.
 */

import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { searchFacets } from '../../db/sqlite/repos/search.repo.ts';
import { namesForPersonIds } from '../../people/people-search-filter.repo.ts';
import { SearchQueryT, type SearchQuery } from './query.ts';
import { resolveSearchScope } from './scope.ts';

/** Canonical (lowercase) hex for a person-id bucket key, so the map lookup
 * against `namesForPersonIds`' canonical keys can't miss on case. Invalid ids
 * pass through untouched — they simply find no name. */
function canonicalHex(id: string): string {
  return ObjectId.isValid(id) ? new ObjectId(id).toHexString() : id;
}

export const facetsRoute = new Elysia().get(
  '/facets',
  async ({ query }) => {
    const where = await resolveSearchScope(query as SearchQuery);
    if (where instanceof Response) return where;

    const facets = await searchFacets(where);

    // Join the person-id buckets to display names; ids whose person is
    // hidden, merged away, or gone drop out (count order is preserved).
    const personNames = await namesForPersonIds(facets.people.map((row) => canonicalHex(row.id)));
    const people = facets.people
      .map((row) => ({ value: personNames.get(canonicalHex(row.id)), count: row.count }))
      .filter((row): row is { value: string; count: number } => typeof row.value === 'string');

    return { ...facets, people };
  },
  { query: SearchQueryT },
);
