import type { Collection } from 'mongodb';
import type { AssetDoc } from '../db/schema.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';

/** Burst window of 5 seconds (temporal proximity). */
export const BURST_WINDOW_MS = 5000;

/**
 * Locate burst siblings: other live assets in the same library root taken within
 * ±5 seconds of the source image's capture time.
 * Returns up to 50 assets.
 */
export async function findBurstSiblings(
  assets: Collection<AssetDoc>,
  image: AssetDoc,
  windowMs: number = BURST_WINDOW_MS,
): Promise<AssetDoc[]> {
  const capturedAt = image.exif?.captured_at;
  if (!capturedAt) return [];

  const primary = assetPrimaryFileInfo(image);
  if (!primary) return [];

  const libraryId = primary.library_id;

  let vt: Date;
  try {
    vt = new Date(capturedAt);
    if (isNaN(vt.getTime())) return [];
  } catch {
    return [];
  }

  const lo = new Date(vt.getTime() - windowMs).toISOString();
  const hi = new Date(vt.getTime() + windowMs).toISOString();

  // Find all sibling assets in the same library within the capture window.
  const siblings = await assets
    .find({
      'exif.captured_at': { $gte: lo, $lte: hi },
      _id: { $ne: image._id },
      fileinfo: {
        $elemMatch: {
          library_id: libraryId,
          deleted_at: { $in: [null] },
          missing_since: { $in: [null] },
        },
      },
    })
    .limit(50)
    .toArray();

  return siblings;
}
