/**
 * DB-backed dismiss action for a person-page merge suggestion — the ONE
 * write path for "not the same person," permanently suppressing a pair via
 * `person_merge_dismissals` (checked by `computeMergeSuggestions` on every
 * subsequent clustering run) and clearing the live suggestion fields on
 * both docs immediately so the UI doesn't wait for the next run.
 */

import type { ObjectId } from 'mongodb';
import { peopleCollection, personMergeDismissalsCollection } from '../db/client.ts';
import { sortedPairKey } from './people-merge-suggestions.ts';

export type DismissMergeSuggestionResult = 'dismissed' | 'stale';

/**
 * Dismiss the suggestion between `personId` and `otherId`. Returns
 * `'stale'` without writing anything if `personId`'s CURRENT
 * `suggested_merge_person_id` isn't `otherId` — the suggestion already
 * changed or cleared server-side (the route maps this to 404, mirroring
 * the merge route's `person not found` → 404 convention).
 */
export async function dismissMergeSuggestion(
  personId: ObjectId,
  otherId: ObjectId,
): Promise<DismissMergeSuggestionResult> {
  const peopleC = await peopleCollection();
  const person = await peopleC.findOne({ _id: personId });
  if (!person || !person.suggested_merge_person_id?.equals(otherId)) {
    return 'stale';
  }

  const pair = sortedPairKey(personId.toHexString(), otherId.toHexString());
  const dismissalsC = await personMergeDismissalsCollection();
  await dismissalsC.updateOne(
    { pair },
    { $setOnInsert: { pair, created_at: new Date().toISOString() } },
    { upsert: true },
  );

  await peopleC.updateOne(
    { _id: personId },
    { $set: { suggested_merge_person_id: null, suggested_merge_score: null } },
  );
  // Only clear the OTHER side if it currently points back at `personId` —
  // don't clobber an unrelated suggestion `otherId` might independently have.
  await peopleC.updateOne(
    { _id: otherId, suggested_merge_person_id: personId },
    { $set: { suggested_merge_person_id: null, suggested_merge_score: null } },
  );

  return 'dismissed';
}
