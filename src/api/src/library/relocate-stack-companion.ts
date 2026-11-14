/**
 * A RAW+JPEG stack's JPEG, found beside its RAW for a relocate or trash that
 * moves the pair as one unit (#5929, #5930).
 */
import * as path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import type { FileInfo } from '../db/schema.ts';
import { isExcludedLocation } from '../fs/mapleignore.ts';
import { loadAssetLocationView } from '../db/repos/assets.locations.repo.ts';
import { pairsAsStack } from './raw-jpeg-stack.ts';

export interface StackCompanionInput {
  id: ObjectId;
  /** What a file holding the JPEG's destination name does: skips the pair or is replaced. */
  collision: 'skip' | 'replace';
}

export interface ResolvedStackCompanion {
  id: ObjectId;
  location: FileInfo;
  sourceAbsPath: string;
}

/** The JPEG's live location in the RAW location `primary`'s folder, under its stem. */
export function companionBeside(
  fileinfo: readonly FileInfo[],
  primary: Pick<FileInfo, 'library_id' | 'path' | 'filename'>,
): FileInfo | null {
  return (
    fileinfo.find(
      (entry) =>
        !entry.deleted_at &&
        !isExcludedLocation(entry) &&
        entry.library_id.equals(primary.library_id) &&
        entry.path === primary.path &&
        pairsAsStack(primary.filename, entry.filename),
    ) ?? null
  );
}

/** The asset `id` as the JPEG beside the RAW at `primaryAbsPath`, or `null`. */
export async function resolveStackCompanion(
  id: ObjectId,
  primary: FileInfo,
  primaryAbsPath: string,
): Promise<ResolvedStackCompanion | null> {
  const view = await loadAssetLocationView(id);
  const location = view ? companionBeside(view.fileinfo, primary) : null;
  return location
    ? {
        id,
        location,
        sourceAbsPath: path.join(path.dirname(primaryAbsPath), location.filename),
      }
    : null;
}
