import * as path from 'node:path';
import type { ObjectId } from '../db/object-id.ts';
import { findCoreInfoById } from '../db/repos/assets.repo.ts';
import { hardDelete } from '../db/repos/assets.trash.ts';
import { fileHash, jailedFile } from '../cloud-backup/inventory.ts';
import { prepareIdenticalReplacementPurge } from '../cloud-backup/lifecycle.ts';
import { unlink, unlinkPrimaryForPurge } from '../fs/mirrored.ts';
import { listPairedSidecars, listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import { trashAssetById } from './asset-trash.ts';
import { publishConflictBytes, sidecarStemClaimedBySibling } from '../fs/sidecar-ownership.ts';
import { readSidecarBytes } from '../fs/sidecar-bytes.ts';
import { serializeSidecarWrite } from '../fs/sidecar-write-order.ts';
import { child as childLogger } from '../log.ts';
import { moveFileToTrash, moveToTrash } from '../fs/trash.ts';

const log = childLogger('library/upload-replacement');

/** Indexed replacement uses the same leased, durable Trash workflow as DELETE.
 * An unindexed file has no catalog or backup identity to fence: media that is
 * merely not indexed yet still carries its sidecars into Trash, while a plain
 * file moves alone — any same-stem `.xmp` belongs to a photo, not to it (#4694). */
export interface UploadReplacement {
  existingId: ObjectId | undefined;
  root: string;
  libraryId: ObjectId;
  original: string;
  relativeDirectory: string;
  filename: string;
  /** Media (indexed or not) carries its `.xmp` sidecars into Trash; a plain file moves alone. */
  pairedWithSidecars: boolean;
}

export async function trashUploadReplacement(replacement: UploadReplacement) {
  const { existingId, root, libraryId, original, relativeDirectory, filename } = replacement;
  if (!existingId) {
    return replacement.pairedWithSidecars
      ? moveToTrash(original, root)
      : moveFileToTrash(original, root);
  }
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

/** Equal bytes don't make an edit redundant: a sidecar first written beside the
 * trashed photo after the purge checked (#5069) follows the replacement as a
 * `(conflict from move)` copy, and leaves the trash under its barrier once
 * copied. One a trashed same-stem sibling still shares stays with that sibling. */
async function carryLateEditsToReplacement(
  trashedPath: string,
  replacementPath: string,
): Promise<void> {
  if (await sidecarStemClaimedBySibling(trashedPath)) return;
  for (const sidecar of await listPairedSidecars(trashedPath)) {
    await serializeSidecarWrite(sidecar, async () => {
      const bytes = await readSidecarBytes(sidecar);
      if (bytes === null) return;
      if (!(await publishConflictBytes(replacementPath, bytes))) {
        throw new Error('no conflict copy could be published');
      }
      await unlink(sidecar);
    }).catch((err: unknown) => {
      log.error(
        { sidecar, err: err instanceof Error ? err.message : err },
        'identical replacement: a late edit could not follow — kept in Trash',
      );
    });
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
  // Never skips the row's deletion: the photo is already gone.
  await carryLateEditsToReplacement(trashedPath, replacementPath).catch((err: unknown) => {
    log.error(
      { trashedPath, err: err instanceof Error ? err.message : err },
      'identical replacement: checking for late edits failed',
    );
  });
  await hardDelete(assetId);
  return true;
}
