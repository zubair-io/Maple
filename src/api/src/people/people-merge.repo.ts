/**
 * Explicit multi-source merge — folds one or more source people into a chosen
 * target (the target always survives). Extracted from `people.repo.ts` to keep
 * both files within the 600-LOC file-budget gate (#1303).
 *
 * Reuses `mergeInto` from `people.repo.ts` and `markAssetsForMeiliReindexBestEffort`
 * from `people-search-reindex.ts` so the repoint / mark logic stays in exactly one place.
 */

import type { ObjectId } from 'mongodb';
import { peopleCollection } from '../db/client.ts';
import type { PersonWithId } from '../db/schema.ts';
import { mergeInto } from './people.repo.ts';
import { markAssetsForMeiliReindexBestEffort } from './people-search-reindex.ts';

/** Result of `mergePeopleInto`. `mergedCount` is the number of sources that
 * were actually folded in (self / already-merged / missing sources are
 * skipped). */
export interface MergePeopleResult {
  survivor: PersonWithId;
  mergedCount: number;
}

/**
 * Merge one or more source people INTO a target. Unlike rename-on-collision
 * (`renamePerson`), the TARGET is always the survivor — it keeps its `_id`,
 * `name`, cover, and `created_at`; every source's faces are repointed at the
 * target and each source row is marked `merged_into = target`. Reuses the same
 * `mergeInto` primitive the rename path uses, so the repoint/mark logic lives
 * in exactly one place.
 *
 * Sources equal to the target, already merged, or missing are skipped
 * (idempotent / defensive). Throws `person not found` / `person already merged`
 * for the target so the route can map them to 404 (mirrors `renamePerson`).
 */
export async function mergePeopleInto(
  targetId: ObjectId,
  sourceIds: ObjectId[],
): Promise<MergePeopleResult> {
  const coll = await peopleCollection();
  const target = await coll.findOne({ _id: targetId });
  if (!target) {
    throw new Error(`person not found: ${targetId.toHexString()}`);
  }
  if (target.merged_into) {
    throw new Error(`person already merged: ${targetId.toHexString()}`);
  }
  let mergedCount = 0;

  // Bulk-fetch every source in one query to avoid an N+1 findOne per id.
  const sources = await coll.find({ _id: { $in: sourceIds } }).toArray();
  // Key by canonical hex string — ObjectId instances are not value-equal as
  // Map keys, so `.get(sourceId)` would always miss without the string form.
  const sourcesById = new Map(sources.map((s) => [s._id.toHexString(), s]));

  // The map is a snapshot taken before the loop, so — unlike the prior
  // per-iteration findOne — a duplicate id would not see the merged_into the
  // first pass wrote. Callers (routes/people.ts) already de-dupe, but track
  // merged ids here so the function is correct on its own regardless.
  const mergedIds = new Set<string>();
  for (const sourceId of sourceIds) {
    const hex = sourceId.toHexString();
    if (sourceId.equals(targetId) || mergedIds.has(hex)) continue;
    const source = sourcesById.get(hex);
    if (!source || source.merged_into) continue;
    // Target stays the survivor; pass its current name so the canonical name
    // is unchanged (no rename on an explicit merge).
    await mergeInto(targetId, sourceId, target.name);
    mergedIds.add(hex);
    mergedCount += 1;
  }
  if (mergedCount > 0) {
    markAssetsForMeiliReindexBestEffort([targetId, ...sourceIds]);
  }
  const fresh = await coll.findOne({ _id: targetId });
  if (!fresh) throw new Error('target disappeared mid-merge');
  return { survivor: fresh as PersonWithId, mergedCount };
}
