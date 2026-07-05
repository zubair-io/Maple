import * as fs from './mirrored.ts';
import { randomBytes } from 'node:crypto';

/**
 * Get the path to the .hidden marker file for the given asset path.
 * The marker file is a sibling of the original photo. Filesystem-only
 * consumers (e.g. the File Provider's `/api/fs/dir`) can check for its
 * existence without querying Mongo; Maple's own UI never depends on it —
 * the DB/XMP override is the sole authoritative source.
 */
export function hiddenMarkerPath(absPath: string): string {
  return `${absPath}.hidden`;
}

/**
 * Write the .hidden marker file on disk. Uses the same atomic
 * write-then-rename pattern as `fs/xmp.ts` (temp name suffixed with
 * `randomBytes(8)`, not just `process.pid` — two concurrent writers in the
 * same process, e.g. the describe stage auto-hiding while a batch-metadata
 * toggle races it, would otherwise collide on the identical temp path).
 */
export async function writeHiddenMarker(absPath: string): Promise<void> {
  const marker = hiddenMarkerPath(absPath);
  const tmp = `${marker}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    await fs.writeFile(tmp, '');
    await fs.rename(tmp, marker);
  } catch {
    // Best-effort, but don't leave an orphaned temp file behind if rename
    // fails after writeFile succeeded (e.g. a cross-device link error) —
    // mirrors the cleanup in fs/xmp.ts's writeXmpAtomic.
    try {
      await fs.unlink(tmp);
    } catch {
      // tmp was never created, or is already gone — nothing to clean up.
    }
  }
}

/**
 * Remove the .hidden marker file if it exists.
 */
export async function removeHiddenMarker(absPath: string): Promise<void> {
  const marker = hiddenMarkerPath(absPath);
  try {
    await fs.unlink(marker);
  } catch {
    // Best-effort, swallow errors.
  }
}
