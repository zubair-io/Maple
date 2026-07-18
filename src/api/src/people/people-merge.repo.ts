/**
 * Explicit multi-source merge — folds one or more source people into a chosen
 * target (the target always survives). Extracted from `people.repo.ts` to keep
 * both files within the 600-LOC file-budget gate (#1303).
 *
 * Owns the `mergeInto` primitive (moved here from `people.repo.ts` for the
 * file-size budget); the rename-on-collision path imports it back, so the
 * repoint / mark logic stays in exactly one place.
 */

import type { ObjectId } from 'mongodb';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { PersonWithId } from '../db/schema.ts';
import { recomputePersonFaceCount } from './people-face-count.repo.ts';
import { markAssetsForMeiliReindexBestEffort } from './people-search-reindex.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:merge');

function nowIso(): string {
  return new Date().toISOString();
}

/** Internal merge helper: repoint `asset.faces[].person_id` from `orphan`
 * to `survivor`, then mark the orphan as `merged_into = survivor`. The
 * survivor's name is canonicalised to `name` (operator spelling).
 *
 * Exported so the rename-on-collision path (`people.repo.ts`) can reuse the
 * same primitive without duplicating the repoint/mark logic. */
export async function mergeInto(survivor: ObjectId, orphan: ObjectId, name: string): Promise<void> {
  const survivorHex = survivor.toHexString();
  const orphanHex = orphan.toHexString();
  const assets = await assetsCollection();
  const peopleC = await peopleCollection();

  // Repoint faces. Faces are stored as a sub-array of objects; Mongo's
  // arrayFilters lets us update every matching element in one pass per
  // asset doc.
  const repoint = await assets.updateMany(
    { 'faces.person_id': orphanHex },
    {
      $set: { 'faces.$[face].person_id': survivorHex },
    },
    {
      arrayFilters: [{ 'face.person_id': orphanHex }],
    },
  );
  // Mark the orphan as merged, zero out its face_count (faces are gone),
  // and drop its own now-moot merge suggestion.
  await peopleC.updateOne(
    { _id: orphan },
    {
      $set: {
        merged_into: survivor,
        updated_at: nowIso(),
        face_count: 0,
        suggested_merge_person_id: null,
        suggested_merge_score: null,
      },
    },
  );
  // Clear any live merge suggestion pointing at the orphan — on the survivor
  // (the banner's own Merge action just resolved it; without this the list
  // badge would stay "possible duplicate" until the next clustering run) and
  // on any third person whose best match was the orphan.
  await peopleC.updateMany(
    { suggested_merge_person_id: orphan },
    { $set: { suggested_merge_person_id: null, suggested_merge_score: null } },
  );
  // Canonicalise the survivor's name + bump updated_at. Centroid is now
  // stale (more faces); the next clustering run will recompute.
  await peopleC.updateOne(
    { _id: survivor },
    {
      $set: {
        name,
        updated_at: nowIso(),
        // Force a centroid recompute on the next pass.
        centroid_face_count: -1,
      },
    },
  );
  // Recompute the survivor's face_count from its ACTUAL assigned, non-hidden
  // faces (now including the repointed ones) rather than summing the orphan's
  // stored count — which may be missing or drifted and would corrupt the
  // survivor. Runs after the repoint so it sees the merged faces.
  await recomputePersonFaceCount(survivorHex);
  log.info(
    {
      survivor: survivorHex,
      orphan: orphanHex,
      faces_repointed: repoint.modifiedCount,
    },
    'merged person',
  );
}

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
