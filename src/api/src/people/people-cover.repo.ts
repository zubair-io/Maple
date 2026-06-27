/**
 * Manual cover selection — pins a specific face as a person's cover thumbnail.
 * Extracted from `people.repo.ts` to keep both files within the 600-LOC
 * file-budget gate, mirroring the `people-merge.repo.ts` split.
 *
 * The bbox is always read SERVER-SIDE from the asset doc; the client supplies
 * only `assetId` + `faceIndex`, never coordinates. A manually-set cover is
 * never clobbered by `backfillCoverAssets` (which only fills MISSING covers).
 *
 * No `any`. snake_case Mongo fields. Logging via the shared child logger.
 */

import { ObjectId } from 'mongodb';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { AssetFaceDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:cover');

/** Result of `setPersonCover`: success, or an error with the HTTP status the
 * route should map it to. */
export type SetPersonCoverResult = { ok: true } | { error: string; status: 400 | 404 };

/**
 * Set a specific face as the person's cover. The bbox is read server-side
 * from the asset doc — the client never supplies coordinates. Validates that
 * the face belongs to this person and is not hidden; returns an error result
 * (with the status to surface) when validation fails.
 */
export async function setPersonCover(
  personId: ObjectId,
  assetId: ObjectId,
  faceIndex: number,
): Promise<SetPersonCoverResult> {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) {
    return { error: `invalid face index: ${faceIndex}`, status: 400 };
  }
  const assets = await assetsCollection();
  const asset = await assets.findOne({ _id: assetId }, { projection: { faces: 1 } });
  if (!asset) {
    return { error: `asset not found: ${assetId.toHexString()}`, status: 404 };
  }
  const faces = (asset.faces ?? []) as AssetFaceDoc[];
  if (faceIndex >= faces.length) {
    return {
      error: `face index out of range: ${faceIndex} (asset has ${faces.length} faces)`,
      status: 400,
    };
  }
  const face = faces[faceIndex];
  if (face.person_id !== personId.toHexString()) {
    return { error: 'face does not belong to this person', status: 400 };
  }
  if (face.hidden === true) {
    return { error: 'face is hidden', status: 400 };
  }
  const coll = await peopleCollection();
  await coll.updateOne(
    { _id: personId },
    {
      $set: {
        cover_asset_id: assetId.toHexString(),
        cover_bbox: face.bbox,
        updated_at: new Date().toISOString(),
      },
    },
  );
  log.info(
    { personId: personId.toHexString(), assetId: assetId.toHexString(), faceIndex },
    'set person cover',
  );
  return { ok: true };
}
