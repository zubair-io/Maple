import * as path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import { findCoreInfoById } from '../db/repos/assets.repo.ts';
import { hardDelete } from '../db/repos/assets.trash.ts';
import { fileHash, jailedFile } from '../cloud-backup/inventory.ts';
import { prepareIdenticalReplacementPurge } from '../cloud-backup/lifecycle.ts';
import { unlinkPrimaryForPurge } from '../fs/mirrored.ts';
import { listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import { trashAssetById } from './asset-trash.ts';
import { moveToTrash } from '../fs/trash.ts';

/** Indexed replacement uses the same leased, durable Trash workflow as DELETE.
 * An unindexed file has no catalog or backup identity to fence. */
export async function trashUploadReplacement(
  existingId: ObjectId | undefined,
  root: string,
  libraryId: ObjectId,
  original: string,
  relativeDirectory: string,
  filename: string,
) {
  if (!existingId) return moveToTrash(original, root);
  const result = await trashAssetById(existingId, {
    entry: { libraryId, path: relativeDirectory, filename },
  });
  if (result.kind === 'ok') return { kind: 'ok' as const, newAbsPath: result.newAbsPath };
  return {
    kind: 'error' as const,
    error: result.kind === 'error' ? result.error : `Replacement Trash unavailable: ${result.kind}`,
  };
}

async function unlinkPurgedPrimary(filename: string): Promise<void> {
  try {
    await unlinkPrimaryForPurge(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Prefix hashes are insufficient for erasure: compare the complete files.
 * Keep multi-location identities and their other surviving copies intact. */
export async function discardIdenticalReplacement(
  assetId: ObjectId,
  root: string,
  trashedPath: string,
  replacementPath: string,
): Promise<boolean> {
  const info = await findCoreInfoById(assetId);
  if (!info || info.fileinfo?.length !== 1) return false;
  if ((await fileHash(trashedPath)) !== (await fileHash(replacementPath))) return false;
  const sidecars = await listPairedSidecarsStrict(trashedPath);
  // Equal RAW bytes do not imply redundant edits or rendered companions.
  if (sidecars.length || info.apple_rendered_path) return false;
  const files = [trashedPath];
  for (const filename of files)
    await jailedFile(root, path.relative(root, filename).split(path.sep).join('/'));
  // Intent and mirror inventories must survive every subsequent local unlink
  // and catalog deletion. Failure retains the row and its association for retry.
  const location = info.fileinfo[0];
  if (
    !(await prepareIdenticalReplacementPurge(assetId.toHexString(), {
      libraryId: location.library_id.toHexString(),
      path: location.path,
      filename: location.filename,
    }))
  )
    return false;
  for (const filename of files) await unlinkPurgedPrimary(filename);
  await hardDelete(assetId);
  return true;
}
