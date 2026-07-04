/**
 * Nearby-asset-folder lookup for the Imports feature (ticket #1752).
 *
 * Split out of `imports/repo.ts` to keep that file under the repo's file-size
 * budget (see `CONTRIBUTING.md`) — this is a single self-contained query, not
 * part of the `imports` collection's claim/lease/progress accessor surface.
 */

import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import type { NearbyAssetCandidate } from './dest.ts';

/**
 * Load every asset already indexed in `libraryId` whose capture time falls
 * in `[minMs, maxMs]`, for in-memory nearest-match lookup by the caller (see
 * `dest.ts`'s `nearestCandidateFolder`, used from `scan.ts`'s
 * `buildImportFiles`).
 *
 * A SINGLE range query for the whole import batch, not one per file: the
 * caller passes the min/max mtime across every file it's about to place
 * (already padded by the proximity window on both ends), so an import of
 * thousands of files costs one query, not thousands.
 *
 * `exif.captured_at` is a UTC ISO string, so the range query is a plain
 * lexicographic compare against the `exif.captured_at` index (same trick as
 * `findDonor` in `workers/migration/audit-video-geo-backfill.ts`).
 *
 * The query's `fileinfo` `$elemMatch` filter is re-used as a `fileinfo.$`
 * positional projection, so each candidate comes back with at most the ONE
 * matching (live, this-library) `fileinfo` entry rather than the asset's full
 * location array.
 */
export async function loadNearbyAssetCandidates(
  libraryId: ObjectId,
  minMs: number,
  maxMs: number,
): Promise<NearbyAssetCandidate[]> {
  const c = await assetsCollection();
  const lo = new Date(minMs).toISOString();
  const hi = new Date(maxMs).toISOString();
  const docs = await c
    .find(
      {
        'exif.captured_at': { $gte: lo, $lte: hi },
        fileinfo: {
          $elemMatch: {
            library_id: libraryId,
            deleted_at: { $in: [null] },
            missing_since: { $in: [null] },
          },
        },
      },
      { projection: { 'fileinfo.$': 1, 'exif.captured_at': 1 } },
    )
    .toArray();

  const out: NearbyAssetCandidate[] = [];
  for (const doc of docs) {
    const capturedAt = doc.exif?.captured_at;
    const entry = doc.fileinfo?.[0];
    if (!capturedAt || !entry) continue;
    out.push({
      capturedAtMs: new Date(capturedAt).getTime(),
      folderPath: entry.path,
    });
  }
  return out;
}
