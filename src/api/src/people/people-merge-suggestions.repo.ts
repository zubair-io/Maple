/**
 * DB-backed dismiss action for a person-page merge suggestion — the ONE
 * write path for "not the same person," permanently suppressing a pair via
 * `person_merge_dismissals` (checked by `computeMergeSuggestions` on every
 * subsequent clustering run) and advancing both docs to their next ranked
 * candidate immediately so the UI doesn't wait for the next run.
 */

import type { Collection, ObjectId, WithId } from 'mongodb';
import { peopleCollection, personMergeDismissalsCollection } from '../db/client.ts';
import type { PersonDoc } from '../db/schema.ts';
import { sortedPairKey } from './people-merge-suggestions.ts';

export type DismissMergeSuggestionResult = 'dismissed' | 'stale';

/** Recompute a person's denormalized head (`suggested_merge_person_id` /
 * `_score`) as the best REMAINING candidate from their ranked
 * `suggested_merges` list, skipping pairs that have been dismissed. Clears
 * both fields when nothing is left. This keeps the list-grid badge honest
 * after a dismiss without waiting on another clustering pass — the detail
 * banner resolves the same way in `loadSuggestedMergeInfo`. */
async function advanceHead(
  peopleC: Collection<PersonDoc>,
  person: WithId<PersonDoc>,
): Promise<void> {
  const list = person.suggested_merges ?? [];
  const personHex = person._id.toHexString();
  let next: { person_id: ObjectId; score: number } | null = null;
  if (list.length > 0) {
    const keys = list.map((c) => sortedPairKey(personHex, c.person_id.toHexString()));
    const dismissalsC = await personMergeDismissalsCollection();
    const rows = await dismissalsC
      .find({ pair: { $in: keys } })
      .project<{ pair: string }>({ pair: 1, _id: 0 })
      .toArray();
    const dismissed = new Set(rows.map((r) => r.pair));
    next =
      list.find((c) => !dismissed.has(sortedPairKey(personHex, c.person_id.toHexString()))) ?? null;
  }
  await peopleC.updateOne(
    { _id: person._id },
    {
      $set: {
        suggested_merge_person_id: next?.person_id ?? null,
        suggested_merge_score: next?.score ?? null,
      },
    },
  );
}

/**
 * Dismiss the suggestion between `personId` and `otherId`. Returns
 * `'stale'` without writing anything when `otherId` isn't one of
 * `personId`'s stored candidates — the suggestion already changed or
 * cleared server-side (the route maps this to 404, mirroring the merge
 * route's `person not found` → 404 convention).
 */
export async function dismissMergeSuggestion(
  personId: ObjectId,
  otherId: ObjectId,
): Promise<DismissMergeSuggestionResult> {
  const peopleC = await peopleCollection();
  const person = await peopleC.findOne({ _id: personId });
  if (!person) return 'stale';
  // Accept ANY of the person's ranked candidates, not just the head: the
  // banner surfaces the best still-VALID one, which can sit behind an
  // already-dismissed or since-merged entry.
  const candidateIds = [
    ...(person.suggested_merges ?? []).map((c) => c.person_id),
    ...(person.suggested_merge_person_id ? [person.suggested_merge_person_id] : []),
  ];
  if (!candidateIds.some((id) => id.equals(otherId))) return 'stale';

  const pair = sortedPairKey(personId.toHexString(), otherId.toHexString());
  const dismissalsC = await personMergeDismissalsCollection();
  await dismissalsC.updateOne(
    { pair },
    { $setOnInsert: { pair, created_at: new Date().toISOString() } },
    { upsert: true },
  );

  // Advance past the pair just dismissed — this side always, and the OTHER
  // side only when it currently points back here (don't clobber an unrelated
  // suggestion `otherId` may independently hold).
  await advanceHead(peopleC, person);
  const other = await peopleC.findOne({ _id: otherId });
  if (other?.suggested_merge_person_id?.equals(personId)) {
    await advanceHead(peopleC, other);
  }

  return 'dismissed';
}
