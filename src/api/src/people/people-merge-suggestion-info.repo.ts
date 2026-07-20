/**
 * Resolves a person's stored merge candidates into display info for the
 * person-page merge-suggestion banner. Extracted from `people.repo.ts` to
 * keep both files within the 600-LOC file-budget gate (mirrors the
 * `people-merge.repo.ts` / `people-cover.repo.ts` split, #1303).
 */

import type { Collection, ObjectId } from 'mongodb';
import type { Bbox, PersonDoc, PersonWithId } from '../db/schema.ts';
import { personMergeDismissalsCollection } from '../db/client.ts';
import { sortedPairKey } from './people-merge-suggestions.ts';

/** Display info for a resolved merge candidate, used by the person-page
 * merge-suggestion banner. */
export interface SuggestedMergeInfo {
  personId: ObjectId;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  score: number;
}

/** The person's ranked candidates, best first. Falls back to the
 * denormalized head fields for rows written before `suggested_merges`
 * landed, so a library that hasn't re-clustered yet still shows its
 * single stored suggestion. */
function rankedCandidates(person: PersonWithId): Array<{ personId: ObjectId; score: number }> {
  const list = person.suggested_merges;
  if (list && list.length > 0) {
    return list.map((c) => ({ personId: c.person_id, score: c.score }));
  }
  if (person.suggested_merge_person_id && person.suggested_merge_score != null) {
    return [{ personId: person.suggested_merge_person_id, score: person.suggested_merge_score }];
  }
  return [];
}

/**
 * Resolve the person's best STILL-VALID merge candidate into display info
 * for the detail-page banner.
 *
 * Walks the ranked list rather than reading a single pointer, skipping any
 * candidate that has since been dismissed, merged away, or hidden. That is
 * what lets the banner advance to the next match the instant one is
 * dismissed or merged, instead of going empty until the next clustering
 * run recomputes. Returns null once nothing valid remains.
 */
export async function loadSuggestedMergeInfo(
  coll: Collection<PersonDoc>,
  person: PersonWithId,
): Promise<SuggestedMergeInfo | null> {
  const candidates = rankedCandidates(person);
  if (candidates.length === 0) return null;

  const personHex = person._id.toHexString();
  // One indexed lookup for just this person's candidate pairs — not the
  // whole dismissal collection.
  const pairKeys = candidates.map((c) => sortedPairKey(personHex, c.personId.toHexString()));
  const dismissalsC = await personMergeDismissalsCollection();
  const dismissedRows = await dismissalsC
    .find({ pair: { $in: pairKeys } })
    .project<{ pair: string }>({ pair: 1, _id: 0 })
    .toArray();
  const dismissed = new Set(dismissedRows.map((r) => r.pair));

  for (const candidate of candidates) {
    const candidateHex = candidate.personId.toHexString();
    if (dismissed.has(sortedPairKey(personHex, candidateHex))) continue;
    const target = await coll.findOne({ _id: candidate.personId });
    if (!target || target.merged_into || target.hidden) continue;
    return {
      personId: target._id,
      name: target.name,
      coverAssetId: target.cover_asset_id ?? null,
      coverBbox: target.cover_bbox ?? null,
      score: candidate.score,
    };
  }
  return null;
}
