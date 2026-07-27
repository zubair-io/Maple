import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';

export const LIVE_ASSET_FILTER = {
  deleted_at: { $in: [null] },
  fileinfo: {
    $elemMatch: {
      deleted_at: { $in: [null] },
      missing_since: { $in: [null] },
    },
  },
} as const;

export async function markAssetsVectorized(
  assetIds: ObjectId[],
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint || assetIds.length === 0) return;
  await (
    await assetsCollection()
  ).updateMany({ _id: { $in: assetIds } }, { $set: { semantic_vector_fingerprint: fingerprint } });
}

/** A completed embedder-settings task re-embeds documents already confirmed
 * in Meilisearch. Carry only those markers forward; unmarked Mongo rows stay
 * uncovered until their stage/backfill task succeeds. */
export async function advanceKnownVectorCoverage(
  fingerprint: string | null | undefined,
): Promise<void> {
  if (!fingerprint) return;
  await (
    await assetsCollection()
  ).updateMany(
    {
      ...LIVE_ASSET_FILTER,
      semantic_vector_fingerprint: { $type: 'string', $ne: '' },
    } as never,
    { $set: { semantic_vector_fingerprint: fingerprint } },
  );
}
