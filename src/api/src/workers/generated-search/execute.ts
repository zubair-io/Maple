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

import type { SearchQuery } from '../../routes/search/query.ts';
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
