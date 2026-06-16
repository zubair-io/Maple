/**
 * Per-location `missing_since` tagging — the one write the stage runner makes
 * when an original-file stage hits ENOENT on a specific location. Extracted
 * from run-stage.ts to keep that file under the size budget.
 */

import type { Collection, ObjectId } from 'mongodb';
// Type-only import — erased at compile, so this does NOT create a runtime
// import cycle with run-stage.ts (which imports the function below).
import type { ImageDoc } from './run-stage.ts';
import type { FileInfo } from '../db/schema.ts';
import { updateLiveLocationCount } from '../indexer/images.repo.ts';

/**
 * Conditional, first-detection `missing_since` stamp on ONE `fileinfo` entry
 * (best-effort). `entry` identifies the location whose file went missing —
 * the `(library_id, path, filename)` triple uniquely names it.
 *
 * The arrayFilter's `$or: [absent, null]` guard means the FIRST detection
 * wins, so the reaper's per-entry age window can't be pushed forward by
 * repeated stage runs. Failures are swallowed — a tagging hiccup must not mask
 * the stage outcome.
 */
export async function tagMissingSince(
  images: Collection<ImageDoc>,
  id: ObjectId,
  entry: Pick<FileInfo, 'library_id' | 'path' | 'filename'>,
): Promise<void> {
  await images
    .updateOne(
      { _id: id },
      { $set: { 'fileinfo.$[e].missing_since': new Date().toISOString() } },
      {
        arrayFilters: [
          {
            'e.library_id': entry.library_id,
            'e.path': entry.path,
            'e.filename': entry.filename,
            $or: [{ 'e.missing_since': { $exists: false } }, { 'e.missing_since': null }],
          },
        ],
      },
    )
    .catch(() => {});
  // Recompute live count after tagging an entry missing_since (best-effort).
  await updateLiveLocationCount(images, id).catch(() => {});
}
