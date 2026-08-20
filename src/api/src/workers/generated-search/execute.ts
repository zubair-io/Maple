/**
 * The single place a stored generated query becomes a live `/api/search`
 * query.
 *
 * Both the worker (measuring a proposal's result count) and the read API
 * (serving the widget and the Maple TV shelf) go through here, so the
 * server-forced constraints cannot drift between what the count claimed and
 * what a consumer actually renders.
 *
 * Forcing happens at EXECUTION time rather than being stamped into the doc at
 * generation time. That is deliberate: a doc written by an earlier version of
 * the worker — or edited directly in Mongo — still cannot surface a
 * soft-hidden person on an unattended living-room screen.
 *
 * Construction is whitelist-only, mirroring `validateProposal`. The stored
 * `query` is the same shape the validator emitted, but stored data is a
 * second way junk can arrive (an older schema, a manual edit), so nothing is
 * spread through — every field is copied by name.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { personIdsToDrop } from '../../people/people.repo.ts';
import { personIdsForNames } from '../../people/people-search-filter.repo.ts';
import {
  buildFilter,
  extractDatesFromQuery,
  peopleNames,
  type SearchQuery,
} from '../../routes/search/query.ts';
import type { GeneratedQuery } from './validate.ts';

/**
 * Build the live query for a stored collection.
 *
 * `libraryId` comes from the caller, never from stored data. `hidden` is left
 * unset so `buildFilter`'s always-on default (`hidden: { $ne: true }`)
 * applies.
 */
export function toSearchQuery(stored: GeneratedQuery, libraryId: string): SearchQuery {
  const query: SearchQuery = {
    libraryId,
    // Soft-hidden people must not reappear on an ambient surface. Not
    // overridable from stored data — see the module note.
    excludeHiddenPeople: 'true',
    // A screenshot inside a themed collection is always wrong.
    isScreenshot: 'false',
  };

  if (stored.placeQuery !== undefined) query.placeQuery = stored.placeQuery;
  if (stored.from !== undefined) query.from = stored.from;
  if (stored.to !== undefined) query.to = stored.to;
  if (stored.month !== undefined) query.month = stored.month;
  if (stored.people !== undefined) query.people = stored.people;
  if (stored.sceneType !== undefined) query.sceneType = stored.sceneType;

  return query;
}

/**
 * Resolve a live query all the way to a Mongo filter, the way
 * `GET /api/search` does: pull natural-language dates out of `placeQuery`,
 * resolve the person ids to drop and the person names to match, then
 * `buildFilter`.
 *
 * Takes an already-forced `SearchQuery` rather than a stored `GeneratedQuery`,
 * so the forcing in `toSearchQuery` happens exactly once at each call site
 * instead of being re-applied here and relying on it being idempotent.
 *
 * Shared by the worker (measuring a candidate) and the read API (rendering a
 * saved one). Keeping it in one function is what stops the two from drifting
 * — a collection measured at 40 photos must not render with four.
 */
export async function resolveLiveFilter(
  query: SearchQuery,
): Promise<{ resolved: SearchQuery; filter: Filter<AssetDoc> } | { error: string }> {
  const resolved = extractDatesFromQuery(query);
  const [dropIds, peopleIds] = await Promise.all([
    personIdsToDrop(resolved.excludeHiddenPeople),
    personIdsForNames(peopleNames(resolved.people)),
  ]);

  const filterOrError = buildFilter(resolved, dropIds, peopleIds);
  if ('error' in filterOrError) return { error: filterOrError.error };
  return { resolved, filter: filterOrError };
}
