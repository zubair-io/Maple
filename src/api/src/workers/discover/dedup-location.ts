/**
 * Shared dedup-hit writer for the discover producer (`handle-event.ts`) —
 * records a `(library_id, path, filename)` location on an existing row for the
 * same content, used by both the main dedup branch and the race-loser fallback.
 *
 * The body moved to `db/sqlite/repos/assets.discover.ts` at the cutover
 * (#3787), where it sits beside the lookups that feed it and the insert it is
 * the alternative to. Two things it used to do by hand are now properties of
 * the schema rather than code: the conditional `$push` that made a concurrent
 * worker's duplicate append a silent no-op is the UNIQUE index over
 * `(library_id, path, filename)` plus `ON CONFLICT DO NOTHING`, and the
 * `updateLiveLocationCount` round trip after every write is the triggers in
 * `ddl/asset-locations.ts`.
 *
 * This module stays as the import path `handle-event.ts` uses, and re-exports
 * the name explicitly rather than with `export *` so a changed shape fails to
 * compile here instead of being swapped silently.
 */
export { appendOrRefreshLocation } from '../../db/sqlite/repos/assets.discover.dedup.ts';
