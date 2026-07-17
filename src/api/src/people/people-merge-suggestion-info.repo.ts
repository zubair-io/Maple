/**
 * Resolves a person's stored `suggested_merge_person_id` into display info
 * for the person-page merge-suggestion banner. Extracted from
 * `people.repo.ts` to keep both files within the 600-LOC file-budget gate
 * (mirrors the `people-merge.repo.ts` / `people-cover.repo.ts` split, #1303).
 */

import type { Collection, ObjectId } from 'mongodb';
import type { Bbox, PersonDoc, PersonWithId } from '../db/schema.ts';

/** Display info for a resolved `suggested_merge_person_id`, used by the
 * person-page merge-suggestion banner. */
export interface SuggestedMergeInfo {
  personId: ObjectId;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  score: number;
}

/**
 * Resolve `person.suggested_merge_person_id` into display info for the
 * detail-page banner. Defensive: a target that's since been merged away or
 * hidden (stale between clustering runs) is treated as "no suggestion"
 * rather than surfacing a broken banner — the next clustering run
 * self-heals the stale reference on the SUBJECT's own doc (Task 4).
 */
export async function loadSuggestedMergeInfo(
  coll: Collection<PersonDoc>,
  person: PersonWithId,
): Promise<SuggestedMergeInfo | null> {
  if (!person.suggested_merge_person_id || person.suggested_merge_score == null) return null;
  const target = await coll.findOne({ _id: person.suggested_merge_person_id });
  if (!target || target.merged_into || target.hidden) return null;
  return {
    personId: target._id,
    name: target.name,
    coverAssetId: target.cover_asset_id ?? null,
    coverBbox: target.cover_bbox ?? null,
    score: person.suggested_merge_score,
  };
}
