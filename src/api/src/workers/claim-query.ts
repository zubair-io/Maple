/**
 * The claim query: which assets a stage may pick up on this tick.
 *
 * Extracted from `run-stage.ts` when the retry-backoff work (#2729) pushed
 * that file past the 600-line hard budget. It is a natural seam — a single
 * pure function building a Mongo filter, already exported and unit-tested on
 * its own, with no dependency on the dispatch or writeback machinery.
 *
 * `run-stage.ts` re-exports it so the suites and stages that import
 * `buildClaimQuery` from there keep working unchanged.
 */

import type { Filter, ObjectId } from 'mongodb';
import { liveFileInfoElemMatch } from '../indexer/images.repo.ts';
import type { ImageDoc } from './stage-config.ts';

export function buildClaimQuery(
  name: string,
  targetVersion: number,
  dependsOn: Array<{ name: string; minVersion: number }>,
  inFlight: Set<ObjectId>,
  claimFilter?: Filter<ImageDoc>,
  now: Date = new Date(),
): Filter<ImageDoc> {
  const filter: Filter<ImageDoc> = {
    $or: [
      { [`stages.${name}.version`]: { $lt: targetVersion } },
      { [`stages.${name}.version`]: { $exists: false } },
    ],
    [`stages.${name}.dead`]: { $ne: true },
    // Retry backoff (#2729). `$not: { $gt: now }` matches a missing field as
    // well as an elapsed one, so rows that have never failed — and every row
    // written before this field existed — stay claimable with no migration.
    // Expressing it as a negation rather than `$lte` is what buys that:
    // `$lte` would silently exclude documents lacking the field entirely.
    [`stages.${name}.next_attempt_at`]: { $not: { $gt: now } },
    // Require at least one LIVE on-disk location. An asset whose every
    // `fileinfo` entry is non-live — `deleted_at` (bytes replaced) or
    // `missing_since` (file vanished) — has nothing to process and is parked
    // for EVERY stage until either the missing-reaper resolves it (recovers a
    // location, or `$pull`s the dead entries and deletes the record) or a
    // re-discover relinks a live location. Replaces the former root
    // `missing_since` park: per-entry `missing_since` now expresses "this
    // location is gone", and a row with no live entry is exactly the parked set.
    ...liveFileInfoElemMatch(),
    // Skip assets tagged damaged (`damaged.since` is an ISO string while
    // tagged): the bytes are unreadable, so the file is parked for EVERY stage
    // until an operator clears the tag from the Workers UI.
    'damaged.since': { $not: { $type: 'string' } },
  };
  for (const dep of dependsOn) {
    (filter as Record<string, unknown>)[`stages.${dep.name}.version`] = {
      $gte: dep.minVersion,
    };
  }
  if (inFlight.size > 0) {
    (filter as Record<string, unknown>)['_id'] = { $nin: [...inFlight] };
  }
  // A stage-supplied predicate (e.g. transcribe's video/audio filename regex)
  // is AND-ed on so it can't collide with the base query's own `fileinfo` /
  // `$or` keys. Absent → the base query is returned unchanged.
  return claimFilter ? { $and: [filter, claimFilter] } : filter;
}
