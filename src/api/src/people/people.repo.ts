/**
 * People repository — CRUD + merge semantics for face-cluster identities.
 *
 * Naming rule: a person's `name` is unique under a case-insensitive
 * collation. Tagging two clusters with the same name MERGES them: the
 * destination keeps the survivor row, the source is marked
 * `merged_into = survivor` (audit trail; hidden from listings), and every
 * `asset.faces[].person_id` pointing at the source is repointed at the
 * survivor. The DB-level unique index is the safety net — the merge logic
 * here is what the route calls.
 *
 * No `any`. snake_case Mongo fields. Logging via the shared child logger.
 */

import type { Collection, Filter, ObjectId } from 'mongodb';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { AssetDoc, AssetFaceDoc, Bbox, PersonDoc, PersonWithId } from '../db/schema.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  markAssetsForMeiliReindexBestEffort,
  markAssetIdsForMeiliReindexBestEffort,
} from './people-search-reindex.ts';
import { adjustPersonFaceCount } from './people-face-count.repo.ts';
import {
  loadSuggestedMergeInfo,
  type SuggestedMergeInfo,
} from './people-merge-suggestion-info.repo.ts';
import { mergeInto } from './people-merge.repo.ts';
import { assertValidPersonName } from './person-name.ts';
import {
  listPeopleByFilter,
  type ListPeopleOptions,
  type PersonWithCount,
} from './people-list-core.ts';
import { child as childLogger } from '../log.ts';
import { safeObjectId } from '../db/safe-object-id.ts';

const log = childLogger('people:repo');

/** Result of `renamePerson`. When a collision triggers a merge the
 * `mergedFrom` field reports the orphan id (the row whose faces were
 * repointed at the survivor). */
export interface RenameResult {
  survivor: PersonWithId;
  mergedFrom?: ObjectId;
}

// PersonWithCount + ListPeopleOptions + the shared list body live in
// people-list-core.ts (cycle-free home shared with the visibility repo);
// re-exported below so importers are unchanged.

/** Result of `getPerson()` with face thumbnails attached. */
export interface PersonDetailFace {
  asset_id: string;
  face_index: number;
  abs_path: string;
  bbox: Bbox;
  confidence: number;
}

export interface PersonDetail {
  person: PersonWithId;
  faces: PersonDetailFace[];
  suggestedMerge: SuggestedMergeInfo | null;
}

export const FACE_DETAIL_LIMIT = 50;
const FACE_DETAIL_MAX = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Case-insensitive name match. Mongo's collation = locale "en", strength 2
 * gives us "Alice" === "alice" === "ALICE" while still matching the unique
 * index in `ensureIndexes`. */
async function findByNameCI(
  coll: Collection<PersonDoc>,
  name: string,
): Promise<PersonWithId | null> {
  return coll.findOne({ name, merged_into: null } as Filter<PersonDoc>, {
    collation: { locale: 'en', strength: 2 },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a person with the given name. If a person with the same name
 * (case-insensitive) already exists, return them — the call is idempotent
 * for the operator's "type a name" UX.
 *
 * Throws on an invalid name — blank, or containing a comma (defensive;
 * the route validates first). See `person-name.ts` for why commas are
 * rejected.
 */
export async function createPerson(name: string): Promise<PersonWithId> {
  const trimmed = assertValidPersonName(name);
  const coll = await peopleCollection();
  const existing = await findByNameCI(coll, trimmed);
  if (existing) return existing;
  const doc: PersonDoc = {
    name: trimmed,
    created_at: nowIso(),
    updated_at: nowIso(),
    merged_into: null,
  };
  try {
    const result = await coll.insertOne(doc as PersonDoc);
    log.info({ id: result.insertedId.toHexString(), name: trimmed }, 'created person');
    return { ...doc, _id: result.insertedId } as PersonWithId;
  } catch (err) {
    // Race: another caller inserted the same name between our findOne and
    // insertOne. Re-fetch and return the survivor.
    const raced = await findByNameCI(coll, trimmed);
    if (raced) return raced;
    throw err;
  }
}

/**
 * Rename a person. If the new name collides with another (live) person,
 * MERGE: every `asset.faces[].person_id` pointing at the source is
 * repointed at the survivor, and the source row is marked
 * `merged_into = survivor`. Returns `{ survivor, mergedFrom }` so callers
 * can tell whether a merge happened.
 *
 * The survivor is determined by lexicographic ObjectId order — the older
 * (smaller) `_id` wins. This makes the operation deterministic regardless
 * of which side of the rename the operator triggered.
 */
export async function renamePerson(id: ObjectId, name: string): Promise<RenameResult> {
  const trimmed = assertValidPersonName(name);
  const coll = await peopleCollection();
  const subject = await coll.findOne({ _id: id });
  if (!subject) {
    throw new Error(`person not found: ${id.toHexString()}`);
  }
  if (subject.merged_into) {
    throw new Error(`person already merged: ${id.toHexString()}`);
  }
  // Name unchanged (case-insensitive) — bump updated_at and return.
  if (subject.name.localeCompare(trimmed, 'en', { sensitivity: 'accent' }) === 0) {
    if (subject.name === trimmed) {
      return { survivor: subject as PersonWithId };
    }
    await coll.updateOne({ _id: id }, { $set: { name: trimmed, updated_at: nowIso() } });
    // Case-only rename still changes the indexed token (e.g. "alice" →
    // "Alice"): re-index this person's assets.
    markAssetsForMeiliReindexBestEffort([id]);
    return { survivor: { ...subject, name: trimmed } as PersonWithId };
  }
  const collision = await findByNameCI(coll, trimmed);
  if (!collision) {
    // No collision — straightforward rename.
    await coll.updateOne({ _id: id }, { $set: { name: trimmed, updated_at: nowIso() } });
    markAssetsForMeiliReindexBestEffort([id]);
    return {
      survivor: { ...subject, name: trimmed } as PersonWithId,
    };
  }
  if (collision._id.equals(id)) {
    // Pointing at ourselves (case-only rename hit the same row). Same as
    // the "name unchanged" branch.
    await coll.updateOne({ _id: id }, { $set: { name: trimmed, updated_at: nowIso() } });
    markAssetsForMeiliReindexBestEffort([id]);
    return { survivor: { ...subject, name: trimmed } as PersonWithId };
  }
  // Collision — merge. Older _id wins.
  const survivor = subject._id.toString() < collision._id.toString() ? subject : collision;
  const orphan = survivor._id.equals(subject._id) ? collision : subject;
  await mergeInto(survivor._id, orphan._id, trimmed);
  // Both sides' assets need re-indexing: the orphan's faces were repointed
  // at the survivor, and the survivor's display name may have changed.
  markAssetsForMeiliReindexBestEffort([survivor._id, orphan._id]);
  // The survivor's stored name should match `trimmed`; both incoming
  // names matched it case-insensitively. We canonicalise to the
  // operator-supplied spelling.
  const fresh = await coll.findOne({ _id: survivor._id });
  if (!fresh) throw new Error('survivor disappeared mid-merge');
  return { survivor: fresh as PersonWithId, mergedFrom: orphan._id };
}

/**
 * List all live (non-merged) people. When `withCounts` is true, attach the
 * face count per person — one aggregation that joins via `asset.faces`.
 *
 * Sorted by `name` ascending under the case-insensitive collation.
 */
export async function listPeople(options: ListPeopleOptions = {}): Promise<PersonWithCount[]> {
  // The normal listing excludes hidden people (`hidden: { $ne: true }` so
  // absent === visible). Hidden persons live on the Hidden page via
  // `listHiddenPeople`. NOTE: this hidden filter is applied at the person
  // level ONLY — the clustering seed queries in `clustering-job.ts` stay
  // unfiltered on purpose so hidden persons keep absorbing their new faces.
  return listPeopleByFilter(
    { merged_into: null, hidden: { $ne: true }, excluded: { $ne: true } },
    options,
  );
}

/** Single person + a page of face thumbnails (asset_id + face_index +
 * bbox), most-recent first by `exif.captured_at`. Supports offset-based
 * pagination via `faceOffset` + `faceLimit`. */
export async function getPerson(
  id: ObjectId,
  faceOffset: number = 0,
  faceLimit: number = FACE_DETAIL_LIMIT,
): Promise<PersonDetail | null> {
  const clampedLimit = Math.min(Math.max(1, faceLimit), FACE_DETAIL_MAX);
  const clampedOffset = Math.max(0, faceOffset);
  const coll = await peopleCollection();
  const person = await coll.findOne({ _id: id });
  if (!person) return null;
  if (person.merged_into) return null;
  const personHex = id.toHexString();
  const assets = await assetsCollection();
  // `$unwind ... includeArrayIndex` gives us the face's array index for
  // free, which is exactly what the UI needs to point a "Move to..."
  // dropdown back at the right element.
  const cursor = assets.aggregate<{
    _id: ObjectId;
    fileinfo?: AssetDoc['fileinfo'];
    face_index: number;
    bbox: Bbox;
    confidence: number;
    captured_at: string | null;
  }>([
    { $match: { 'faces.person_id': personHex } },
    // Only assets that still resolve to a file — a live `fileinfo` entry
    // (neither deleted nor missing). This MUST run before $sort/$skip/$limit:
    // the per-row `assetAbsPath` filter below drops unresolvable assets in JS,
    // and applying it AFTER the DB pagination let a page window land entirely
    // on missing/deleted assets and return empty while thousands of resolvable
    // faces sat on later pages (#2103). A resolvable asset always has a live
    // entry, so this pre-filter is no stricter than `assetAbsPath` — it never
    // drops a face that would have resolved, it just stops unresolvable faces
    // from consuming the page window. `assetAbsPath` stays the authoritative
    // per-row resolver (it also handles the rarer unregistered-library case).
    { $match: { fileinfo: { $elemMatch: { deleted_at: null, missing_since: null } } } },
    {
      $unwind: { path: '$faces', includeArrayIndex: 'face_index' },
    },
    { $match: { 'faces.person_id': personHex } },
    // Drop hidden faces — the operator marked them as not-tracked, so
    // they should not appear in any person panel.
    { $match: { 'faces.hidden': { $ne: true } } },
    {
      $project: {
        fileinfo: 1,
        face_index: 1,
        bbox: '$faces.bbox',
        confidence: '$faces.confidence',
        captured_at: { $ifNull: ['$exif.captured_at', null] },
      },
    },
    { $sort: { captured_at: -1, _id: 1 } },
    { $skip: clampedOffset },
    { $limit: clampedLimit },
  ]);
  const libs = await loadLibraryRoots();
  const faces: PersonDetailFace[] = [];
  for await (const row of cursor) {
    const abs = assetAbsPath(row, libs);
    if (!abs) continue; // skip rows with no resolvable location
    faces.push({
      asset_id: row._id.toHexString(),
      face_index: row.face_index,
      abs_path: abs,
      bbox: row.bbox,
      confidence: row.confidence,
    });
  }
  const suggestedMerge = await loadSuggestedMergeInfo(coll, person);
  return { person, faces, suggestedMerge };
}

/**
 * Set the `person_id` for a single face on an asset. Pass `null` to
 * unassign the face.
 *
 * This is the "manual override" path used when the operator drags a face
 * to a different person (or unassigns it). Throws if the asset or face
 * doesn't exist.
 */
export async function assignFaceToPerson(
  assetId: ObjectId,
  faceIndex: number,
  personId: ObjectId | null,
): Promise<void> {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) {
    throw new Error(`invalid face index: ${faceIndex}`);
  }
  const assets = await assetsCollection();
  const personHex = personId ? personId.toHexString() : null;
  // Use the positional path with the index baked in. We can't use $set with
  // a literal index on an array element if the path doesn't exist; verify
  // first.
  const asset = await assets.findOne({ _id: assetId }, { projection: { faces: 1 } });
  if (!asset) throw new Error(`asset not found: ${assetId.toHexString()}`);
  const faces = (asset.faces ?? []) as AssetFaceDoc[];
  if (faceIndex >= faces.length) {
    throw new Error(`face index out of range: ${faceIndex} (asset has ${faces.length} faces)`);
  }
  // Capture the prior person before the write so we can re-index BOTH the
  // person losing the face and the person gaining it.
  const priorPersonId = faces[faceIndex]?.person_id ?? null;
  await assets.updateOne(
    { _id: assetId },
    { $set: { [`faces.${faceIndex}.person_id`]: personHex } },
  );

  // Only act when the person_id actually changed — an idempotent reassign to
  // the same person should not trigger centroid recomputes, count adjustments,
  // or Meili reindexing.
  if (priorPersonId !== personHex) {
    const peopleC = await peopleCollection();
    const dirtyIds: ObjectId[] = [];
    if (priorPersonId) {
      const oid = safeObjectId(priorPersonId);
      if (oid) dirtyIds.push(oid);
    }
    if (personId) dirtyIds.push(personId);

    if (dirtyIds.length > 0) {
      await peopleC.updateMany(
        { _id: { $in: dirtyIds } },
        { $set: { centroid_face_count: -1, updated_at: nowIso() } },
      );
    }

    // Adjust denormalised face counts. Only visible (non-hidden) faces are
    // counted: if the face was hidden its prior person_id was already null'd
    // (hideFace writes both together) so priorPersonId is null here and we
    // correctly skip the decrement.
    const faceIsHidden = faces[faceIndex]?.hidden === true;
    if (!faceIsHidden) {
      // Decrement the person losing the face.
      if (priorPersonId) await adjustPersonFaceCount(priorPersonId, -1);
      // Increment the person gaining the face.
      if (personHex) await adjustPersonFaceCount(personHex, 1);
    }

    // Only this asset's people set changed — re-index exactly it.
    markAssetIdsForMeiliReindexBestEffort([assetId]);
  }
}

/**
 * Mark a face as hidden — the operator's "this isn't a face I want
 * tracked" action. Hidden faces are excluded from clustering and from
 * every person panel. Writes both `hidden = true` and `person_id = null`
 * in one update so the doc never sits in a half-state (a hidden face
 * still pointing at a person would show up nowhere in the UI but still
 * inflate that person's centroid on the next recompute).
 *
 * Idempotent — calling on an already-hidden face is a no-op.
 */
export async function hideFace(assetId: ObjectId, faceIndex: number): Promise<void> {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) {
    throw new Error(`invalid face index: ${faceIndex}`);
  }
  const assets = await assetsCollection();
  const asset = await assets.findOne({ _id: assetId }, { projection: { faces: 1 } });
  if (!asset) throw new Error(`asset not found: ${assetId.toHexString()}`);
  const faces = (asset.faces ?? []) as AssetFaceDoc[];
  if (faceIndex >= faces.length) {
    throw new Error(`face index out of range: ${faceIndex} (asset has ${faces.length} faces)`);
  }
  const priorPersonId = faces[faceIndex]?.person_id ?? null;
  await assets.updateOne(
    { _id: assetId },
    {
      $set: {
        [`faces.${faceIndex}.hidden`]: true,
        [`faces.${faceIndex}.person_id`]: null,
      },
    },
  );

  // Hiding drops the face's person — mark them as "dirty" for recompute,
  // decrement their denormalised face count, and re-index only this asset.
  if (priorPersonId) {
    const oid = safeObjectId(priorPersonId);
    if (oid) {
      const peopleC = await peopleCollection();
      await peopleC.updateOne(
        { _id: oid },
        { $set: { centroid_face_count: -1, updated_at: nowIso() } },
      );
    }
    // Only decrement if the face was previously visible (not already hidden).
    // We read the face BEFORE the write so if it was already hidden its prior
    // person_id was already null and priorPersonId would be null — but defend
    // against a re-hide anyway by checking the pre-write hidden flag.
    const wasAlreadyHidden = faces[faceIndex]?.hidden === true;
    if (!wasAlreadyHidden) {
      await adjustPersonFaceCount(priorPersonId, -1);
    }
    markAssetIdsForMeiliReindexBestEffort([assetId]);
  }
}

export type { ListPeopleOptions, PersonWithCount } from './people-list-core.ts';

// Visibility toggles + id lists (hide #2124, exclude #2894) live in
// people-visibility.repo.ts; re-exported here so importers are unchanged.
export {
  personIdsToDrop,
  hidePerson,
  unhidePerson,
  excludePerson,
  unexcludePerson,
  listHiddenPeople,
  listExcludedPeople,
} from './people-visibility.repo.ts';

/**
 * Returns the asset's `faces[]` array. Helper used by the clustering job + tests.
 */
export async function readFaces(assetId: ObjectId): Promise<AssetFaceDoc[]> {
  const doc = await (
    await assetsCollection()
  ).findOne({ _id: assetId }, { projection: { faces: 1 } });
  return (doc?.faces ?? []) as AssetFaceDoc[];
}
