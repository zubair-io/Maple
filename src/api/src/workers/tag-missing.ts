/**
 * Per-location `missing_since` tagging — the one write the stage runner makes
 * when an original-file stage hits ENOENT on a specific location. Extracted
 * from run-stage.ts to keep that file under the size budget.
 */

import * as path from 'node:path';
import type { Collection, ObjectId } from 'mongodb';
// Type-only import — erased at compile, so this does NOT create a runtime
// import cycle with run-stage.ts (which imports the function below).
import type { ImageDoc } from './run-stage.ts';
import type { FileInfo } from '../db/schema.ts';
import { updateLiveLocationCount } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { libraryRootAvailable, statKind } from './missing-reaper.helpers.ts';

/**
 * Confirm-before-tag (#2171): a handler-level ENOENT is only a CLAIM that the
 * file is gone — it can also be a race (file mid-move), a stale negative
 * cache on a network share, or an unmounted library root (under which every
 * child path ENOENTs). Before stamping `missing_since`, resolve the entry
 * against its registered library root and require:
 *   1. the root is available (listable + non-empty — see
 *      `libraryRootAvailable`), and
 *   2. a fresh re-stat of the exact path confirms ENOENT.
 * Anything else refuses the tag; the caller's attempt rollback leaves the row
 * claimable, so a transient blip just retries on a later poll.
 *
 * Returns whether the entry was tagged. Failures are swallowed — a tagging
 * hiccup must not mask the stage outcome.
 */
export async function confirmAndTagMissing(
  images: Collection<ImageDoc>,
  id: ObjectId,
  entry: Pick<FileInfo, 'library_id' | 'path' | 'filename'>,
  reason: string,
): Promise<boolean> {
  let root: string | undefined;
  try {
    // ObjectId stringifies to its hex form — the roots map's key.
    root = (await loadLibraryRoots()).get(String(entry.library_id));
  } catch {
    root = undefined;
  }
  if (!root) return false; // unregistered library — nothing to verify against
  if (!(await libraryRootAvailable(root))) return false; // root gone ≠ file gone
  const segments = entry.path === '' ? [] : entry.path.split('/');
  if ((await statKind(path.join(root, ...segments, entry.filename))) !== 'absent') return false;
  await tagMissingSince(images, id, entry, reason);
  return true;
}

/**
 * Conditional, first-detection `missing_since` stamp on ONE `fileinfo` entry
 * (best-effort). `entry` identifies the location whose file went missing —
 * the `(library_id, path, filename)` triple uniquely names it. `reason` is
 * the structured provenance recorded alongside the tag (see
 * `FileInfo.missing_reason`).
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
  reason: string,
): Promise<void> {
  await images
    .updateOne(
      { _id: id },
      {
        $set: {
          'fileinfo.$[e].missing_since': new Date().toISOString(),
          'fileinfo.$[e].missing_reason': reason,
        },
      },
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
